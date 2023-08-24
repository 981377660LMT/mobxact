// Learn Once,Write Anywhere (React 的 slogan)
// 只要是个树形的组件系统，react 都能上去用
//
// React的Reconciler（协调器）是React内部的一个核心模块，
// 它的主要职责是比较新旧两个虚拟DOM树的差异，并根据差异来更新真实DOM。
// 这个过程被称为Reconciliation（协调或者调和）。
//
// Reconciler的工作可以分为两个阶段：Diff阶段和Commit阶段。
// 在Diff阶段，Reconciler会遍历新旧两棵虚拟DOM树，找出两者之间的差异；
// 在Commit阶段，Reconciler会将找出的差异应用到真实的DOM上。

import { Child, IDisposeable, ValueOrObservable } from './common';
import { VirtualMountPoint } from './vdom';

/**
 * 对当前环境的抽象，用于渲染器和宿主环境之间的通信。
 */
export interface ReconcilerHost<
  NodeType = unknown,
  ElementType extends NodeType = NodeType,
  TextNodeType extends NodeType = NodeType
> {
  createElement(tag: string): ElementType;
  createTextNode(text: string): TextNodeType;

  /**
   * 切换Reconciler, 可以通用一个渲染器渲染.
   */
  getChildHostContext?(
    parentContext: Reconciler,
    tag: string
  ): Reconciler<NodeType> | null;

  // 按照 html 的范式设计
  insertBefore(
    parent: ElementType,
    child: NodeType,
    before: NodeType | null // null 表示插入到最后
  ): void;
  removeChild(parent: ElementType, child: NodeType): void;
  setProperty(node: ElementType, key: string, value: unknown): void;
  setCSSProperty(node: ElementType, key: string, value: unknown): void;
  setTextContent(node: TextNodeType, text: string): void;
}

/**
 * 渲染器，它接收一个 ReconcilerHost 实例作为参数，然后提供一个 render 方法用于渲染元素。
 */
export class Reconciler<
  NodeType = unknown,
  ElementType extends NodeType = NodeType,
  TextNodeType extends NodeType = NodeType
> {
  constructor(
    readonly host: ReconcilerHost<NodeType, ElementType, TextNodeType>
  ) {}

  render(
    el: ValueOrObservable<Child>,
    parent: ElementType,
    before: NodeType | null = null
  ): IDisposeable {
    const ret = new VirtualMountPoint<NodeType, ElementType, TextNodeType>(
      this,
      el,
      () => {}
    );
    ret.mount(parent, () => before);
    return {
      dispose: () => {
        ret.unmount();
        ret.dispose();
      },
    };
  }
}
