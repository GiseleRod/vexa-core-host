//vexa-core-host/src/protocol.ts
// Tipos compartidos entre hosts (LS, Electron, etc.).
// No hay lógica acá, solo la forma de los mensajes/estructuras.
export type { Diagnostic } from "../../vexa-ide/dist/core/diagnostics/types.js";
export type { VisualState } from "../../vexa-ide/dist/core/visualState.js";
export type { RenameResult } from "../../vexa-ide/dist/core/renameApply.js";
import type { DocumentSnapshot } from "../../vexa-ide/dist/document/snapshot.js";

export interface DocumentChangedInput {
  type: "documentChanged";
  document: DocumentSnapshot;
}

export interface CursorMovedInput {
  type: "cursorMoved";
  offset: number;
}

export type CoreInputEvent = DocumentChangedInput | CursorMovedInput;
