// 为什么有vDom?
//
// 1. 我们要有 update:
//   text 发生变化
//   DOM 上的属性发生变化(在vDom上绑定，但是变化过程不通过vDom)
//   列表发生变化 - 最复杂部分
// 2. 我们要有 基本的生命周期：
//   init: 唯一一次发起render的时候(对外部的api)
//   mount: 可能会被移动(内部的私有方法)
//   unmount：可能会被移动(内部的私有方法)
//   dispose: 组件不再被需要的时候(对外部的api)
// 3. 实际上做了三种VDom的实现：
//   DOMMountPoint: 关联一个真正的DOM Element
//   VirtualMountPoint: 唯一关心Element的部分，同时负责TextNode的渲染更新
//   ListMountPoint: 处理数组/列表渲染
//
// 注意：
// 1.如果child中出现了BoxedObservable，那么会有一层额外的VirtualMountPoint去负责订阅
// 2.每个ListMountPoint中的VirtualMountPoint都会报告首个DOM是啥，然后就知道了before是啥

import {
  isBoxedObservable,
  isComputed,
  reaction,
  IReactionDisposer,
  isObservableArray,
  observe,
} from 'mobx';
import { BitSet } from './bitset';
import {
  Child,
  Children,
  ComponentType,
  IBoxedValue,
  isElement,
  RefFunction,
  RefObject,
  ValueOrObservable,
} from './common';
import { calcKeepList } from './lis';
import { Reconciler } from './reconciler';

export interface IMountPoint<
  NodeType = unknown,
  ElementType extends NodeType = NodeType,
  TextNodeType extends NodeType = NodeType
> {
  // insert dom at specfic place.
  mount(parent: ElementType, before: () => NodeType | null): void;

  // unmount self, do not unmount children.
  // 注意unmount不会unmount children。主要用于移动.
  unmount(): void;

  // dispose self and all children.
  dispose(): void;
}

export class DOMMountPoint<
  NodeType = unknown,
  ElementType extends NodeType = NodeType,
  TextNodeType extends NodeType = NodeType
> implements IMountPoint<NodeType, ElementType, TextNodeType>
{
  readonly _dom: ElementType;
  readonly _ref?: RefObject<ElementType>;
  readonly childReconciler: Reconciler<NodeType, ElementType, TextNodeType>;

  mountIndex = -1;

  constructor(
    readonly reconciler: Reconciler<NodeType>,
    tag: string,
    props: any,
    /**
     * 告诉外部渲染出来的DOM是什么
     */
    readonly onMountedDomChanged: (v: NodeType | null) => void
  ) {
    // 是否需要切换环境
    this.childReconciler = (reconciler.host.getChildHostContext?.(
      reconciler,
      tag
    ) ?? reconciler) as Reconciler<NodeType, ElementType, TextNodeType>;
    const dom = (this._dom = this.childReconciler.host.createElement(tag));

    // props绑定
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (key === 'ref') {
          this._ref = value;
          continue;
        }

        if (key === 'children') {
          continue;
        }

        if (key === 'style') {
          for (const key of Object.keys(value)) {
            const cssValue = value[key];
            if (isBoxedObservable(cssValue) || isComputed(cssValue)) {
              this.disposes.push(
                // 创建一个reaction订阅，当cssValue变化的时候，调用reconciler的setCSSProperty方法
                reaction(
                  () => cssValue.get(),
                  (v) => {
                    this.reconciler.host.setCSSProperty(dom, key, v);
                  },
                  {
                    fireImmediately: true,
                  }
                )
              );
            } else {
              this.reconciler.host.setCSSProperty(dom, key, cssValue);
            }
          }
          continue;
        }

        if (isBoxedObservable(value) || isComputed(value)) {
          this.disposes.push(
            reaction(
              () => value.get(),
              (v) => {
                this.reconciler.host.setProperty(dom, key, v);
              },
              {
                fireImmediately: true,
              }
            )
          );
        } else {
          this.reconciler.host.setProperty(dom, key, value);
        }
      }

      // !有children的话，需要创建一个ListMountPoint
      if (props.children) {
        const mp = new ListMountPoint(
          this.childReconciler,
          props.children,
          () => {}
        );
        mp.mount(dom, () => null);
      }
    }

    this.updateRef(dom);
  }

  disposes: IReactionDisposer[] = [];

  children?: IMountPoint;

  parent?: ElementType;

  // before由ListMountPoint提供
  mount(parent: ElementType, before: () => NodeType | null) {
    this.parent = parent;
    this.onMountedDomChanged(this._dom); // 把真实的dom传出去
    this.reconciler.host.insertBefore(parent, this._dom, before());
  }

  unmount() {
    this.onMountedDomChanged(null); // 维护的是List中的dom，所以这里需要销毁
    this.reconciler.host.removeChild(this.parent!, this._dom);
    delete this.parent;
  }

  dispose() {
    for (const item of this.disposes) {
      item();
    }
    this.updateRef(null);
    if (this.children) {
      this.children.dispose();
    }
  }

  updateRef(ins: ElementType | null) {
    const v = this._ref;
    if (v) {
      if (typeof v === 'function') {
        (v as RefFunction<unknown>)(ins);
      } else {
        (v as RefObject<unknown>).set(ins);
      }
    }
  }
}

export class VirtualMountPoint<
  NodeType = unknown,
  ElementType extends NodeType = NodeType,
  TextNodeType extends NodeType = NodeType
> implements IMountPoint<NodeType, ElementType, TextNodeType>
{
  constructor(
    readonly reconciler: Reconciler<NodeType, ElementType, TextNodeType>,
    el: ValueOrObservable<Child | Children>,
    readonly onMountedDomChanged: (v: NodeType | null) => void
  ) {
    if (isBoxedObservable(el) || isComputed(el)) {
      this.disposeReaction = reaction(
        () => (el as IBoxedValue<Child>).get(),
        (ch) => {
          this.update(ch);
        },
        { fireImmediately: true }
      );
    } else {
      this.update(el as Child);
    }
  }

  mountIndex = -1;

  childMountPoint?: IMountPoint;
  textDom?: TextNodeType;
  disposeReaction?: IReactionDisposer;

  parent?: ElementType;
  before?: () => NodeType | null;

  private update(ch: Child | Children) {
    if (this.textDom && (typeof ch === 'string' || typeof ch === 'number')) {
      // quick update textDOM
      this.reconciler.host.setTextContent(this.textDom, ch.toString());
      return;
    }

    if (
      this.childMountPoint instanceof ListMountPoint &&
      (Array.isArray(ch) || isObservableArray(ch))
    ) {
      (this.childMountPoint as ListMountPoint).update(ch);
      return;
    }

    // 没有rerender,不做dom diff, 直接重新创建
    this.unmountChildren();
    this.disposeChildren();
    if (isElement(ch)) {
      if (typeof ch.type === 'string') {
        this.childMountPoint = new DOMMountPoint<
          NodeType,
          ElementType,
          TextNodeType
        >(this.reconciler, ch.type, ch.props, this.onMountedDomChanged);
      } else {
        this.childMountPoint = new VirtualMountPoint<
          NodeType,
          ElementType,
          TextNodeType
        >(
          this.reconciler,
          (ch.type as ComponentType)(ch.props),
          this.onMountedDomChanged
        );
      }
    } else if (typeof ch === 'string' || typeof ch === 'number') {
      this.textDom = this.reconciler.host.createTextNode(ch.toString());
    } else if (Array.isArray(ch) || isObservableArray(ch)) {
      this.childMountPoint = new ListMountPoint(
        this.reconciler,
        ch,
        this.onMountedDomChanged
      );
    } else if (isBoxedObservable(ch) || isComputed(ch)) {
      this.childMountPoint = new VirtualMountPoint<
        NodeType,
        ElementType,
        TextNodeType
      >(this.reconciler, ch, this.onMountedDomChanged);
    }

    if (this.parent) {
      this.mountChildren();
    }
  }

  mountChildren() {
    if (this.textDom) {
      this.onMountedDomChanged(this.textDom);
      this.reconciler.host.insertBefore(
        this.parent!,
        this.textDom,
        this.before!()
      );
    }
    if (this.childMountPoint) {
      this.childMountPoint.mount(this.parent, this.before!);
    }
  }

  mount(parent: ElementType, before: () => NodeType | null) {
    this.parent = parent;
    this.before = before;
    this.mountChildren();
  }

  disposeChildren() {
    if (this.childMountPoint) {
      this.childMountPoint.dispose();
      delete this.childMountPoint;
    }
    if (this.textDom) {
      delete this.textDom;
    }
  }

  unmountChildren() {
    if (this.childMountPoint) {
      this.childMountPoint.unmount();
    }
    if (this.textDom) {
      this.onMountedDomChanged(null);
      this.reconciler.host.removeChild(this.parent!, this.textDom);
    }
  }

  unmount() {
    this.unmountChildren();
    delete this.parent;
    delete this.before;
  }

  dispose() {
    this.disposeChildren();
    if (this.disposeReaction) {
      this.disposeReaction();
      delete this.disposeReaction;
    }
  }
}

export class ListMountPoint<
  NodeType = unknown,
  ElementType extends NodeType = NodeType,
  TextNodeType extends NodeType = NodeType
> implements IMountPoint<NodeType, ElementType, TextNodeType>
{
  children: VirtualMountPoint<NodeType, ElementType, TextNodeType>[] = [];
  doms: (NodeType | null)[] = [];
  el: Children;

  mountIndex = -1;

  parent?: ElementType;
  before?: () => NodeType | null;

  firstDom: Node | null = null;

  updating = false;
  bitset: BitSet | null = null; // when batch updating, it should be null.

  constructor(
    readonly reconciler: Reconciler<NodeType, ElementType, TextNodeType>,
    el: Children,
    readonly onMountedDomChanged: (v: NodeType | null) => void
  ) {
    let idx = 0;
    this.updating = true;
    for (const item of el) {
      const mp: VirtualMountPoint<NodeType, ElementType, TextNodeType> =
        new VirtualMountPoint<NodeType, ElementType, TextNodeType>(
          reconciler,
          item,
          (v) => this.onChildMountedDomChanged(mp, v)
        );
      mp.mountIndex = idx++; // 反向查询，直接作为props性能更好
      this.children.push(mp);
    }
    this.updating = false;
    this.el = el;

    if (isObservableArray(el)) {
      // should copy & record current list.
      this.el = [...el];
      this.disposeReaction = observe(el, () => {
        this.update([...el]);
      });
    }
  }

  onChildMountedDomChanged(
    mp: VirtualMountPoint<NodeType, ElementType, TextNodeType>,
    dom: NodeType | null
  ) {
    this.doms[mp.mountIndex] = dom;

    if (this.bitset) {
      if (dom) {
        this.bitset.set(mp.mountIndex);
      } else {
        this.bitset.unset(mp.mountIndex);
      }
    }
    if (!this.updating) {
      this.updateFirstDom();
    }
  }

  buildBitset() {
    this.bitset = new BitSet(this.children.length, this.doms);
  }

  updateFirstDom() {
    if (!this.bitset) {
      return;
    }
    const q = this.bitset.query();
    this.onMountedDomChanged(q >= 0 ? this.doms[q] : null);
  }

  update(el: Children) {
    const oldChildren = this.children;
    const map = new Map<any, number>();
    this.bitset = null;
    this.updating = true;

    // TODO: try to keep as many as possible with preprocess + LIS.
    for (let i = 0; i < this.el.length; i++) {
      map.set(this.el[i], i);
    }
    const order: number[] = [];
    for (let i = 0; i < el.length; i++) {
      if (map.has(el[i])) {
        order.push(map.get(el[i])!);
      }
    }
    const keep = calcKeepList(order, oldChildren.length);

    for (let i = 0; i < this.el.length; i++) {
      if (this.parent && !keep[i]) {
        this.children[i].unmount();
      }
    }
    const oldDoms = this.doms;
    this.doms = [];
    this.children = [];
    const willMount = [];
    for (let i = 0; i < el.length; i++) {
      if (map.has(el[i])) {
        const oldIdx = map.get(el[i])!;
        const mp = oldChildren[oldIdx];
        mp.mountIndex = i;
        map.delete(el[i]);
        this.children.push(mp);
        if (!keep[oldIdx]) {
          willMount.push(mp);
        } else {
          this.doms[i] = oldDoms[oldIdx];
        }
      } else {
        const mp: VirtualMountPoint<NodeType, ElementType, TextNodeType> =
          new VirtualMountPoint<NodeType, ElementType, TextNodeType>(
            this.reconciler,
            el[i],
            (v) => this.onChildMountedDomChanged(mp, v)
          );
        this.children.push(mp);
        mp.mountIndex = i;
        willMount.push(mp);
      }
    }
    this.buildBitset();
    if (this.parent) {
      for (const mp of willMount) {
        mp.mount(this.parent, () => this.getMountBefore(mp));
      }
    }
    for (const value of Array.from(map.values())) {
      oldChildren[value].dispose();
    }
    this.el = el;
    this.updating = false;
    this.updateFirstDom();
  }

  disposeReaction?: () => void;

  mount(parent: ElementType, before: () => NodeType | null) {
    this.parent = parent;
    this.before = before;
    this.bitset = null;
    for (const item of this.children) {
      item.mount(this.parent, () => this.getMountBefore(item));
    }
    this.buildBitset();
    this.updateFirstDom();
  }

  getMountBefore(mp: VirtualMountPoint<NodeType, ElementType, TextNodeType>) {
    if (!this.bitset) {
      // always push to end.
      return this.before!();
    }
    let idx = this.bitset.query(mp.mountIndex + 1);
    if (idx >= 0) {
      return this.doms[idx];
    }

    return this.before!();
  }

  unmount() {
    for (const item of this.children) {
      item.unmount();
    }
    delete this.parent;
    delete this.before;
  }

  dispose() {
    for (const item of this.children) {
      item.dispose();
    }
    this.children = [];
    if (this.disposeReaction) {
      this.disposeReaction();
      delete this.disposeReaction;
    }
  }
}
