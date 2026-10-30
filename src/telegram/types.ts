// Structural view-models over GramJS custom objects. We only type the fields
// the UI actually reads, and cast at the boundary — this avoids depending on
// teleproto's internal type paths which differ across versions.
import type { Api } from "teleproto";

export interface Dialog {
  id?: unknown;
  title?: string;
  name?: string;
  date?: number;
  unreadCount?: number;
  message?: Api.Message;
  entity?: Api.TypeEntityLike;
  inputEntity?: Api.TypeEntityLike;
  isUser?: boolean;
  isGroup?: boolean;
  isChannel?: boolean;
  pinned?: boolean;
  archived?: boolean;
  folderId?: number;
  /** Raw Api.Dialog (notifySettings, unreadMark, readOutboxMaxId, draft…). */
  dialog?: any;
}
