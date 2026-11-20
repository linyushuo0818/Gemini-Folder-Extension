export interface DraggedChat {
  conversationId: string;
  sourceProjectId: string | null;
}

// HTML5 拖拽在 dragover 阶段限制读取 dataTransfer.getData，使用内存态跨 Shadow DOM 校验合法性。
let activeDraggedChat: DraggedChat | null = null;

export function setActiveDraggedChat(chat: DraggedChat | null): void {
  activeDraggedChat = chat;
}

export function getActiveDraggedChat(): DraggedChat | null {
  return activeDraggedChat;
}

export function clearActiveDraggedChat(): void {
  activeDraggedChat = null;
}
