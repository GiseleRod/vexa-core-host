//vexa-core-host/src/index.ts
import { SimpleEventBus } from "../../vexa-ide/dist/core/eventBusImpl.js";
import type { Diagnostic } from "../../vexa-ide/dist/core/diagnostics/types.js";
import type { DocumentSnapshot } from "../../vexa-ide/dist/document/snapshot.js";
import type { VisualState } from "../../vexa-ide/dist/core/visualState.js";
import { attachDiagnosticLifecycle } from "../../vexa-ide/dist/core/diagnostics/diagnosticLifecycle.js";
import { attachSyntaxPass } from "../../vexa-ide/dist/core/semantic/attachSyntaxPass.js";
import { attachSemanticPass } from "../../vexa-ide/dist/core/semantic/attachSemanticPass.js";
import { attachDiagnosticsBridge } from "../../vexa-ide/dist/lsp/diagnosticsBridge.js";
import { attachInteractionController } from "../../vexa-ide/dist/controllers/interactionController.js";
import { NodeIndex } from "../../vexa-ide/dist/core/nodeIndex.js";
import { buildTreeView } from "../../vexa-ide/dist/core/treeView.js";
import { CommandBus } from "../../vexa-ide/dist/core/commandBus.js";
import { createRenameApplyCommand } from "../../vexa-ide/dist/core/commands/renameApplyCommand.js";
import type { RenameResult } from "../../vexa-ide/dist/core/renameApply.js";
import type { CoreInputEvent } from "./protocol.js";

export interface CoreHostDeps {
  publishDiagnostics: (uri: string, diags: any[], version?: number | null) => void;
  // Reservado para hosts con UI (hover/rename necesitan texto por URI).
  getTextForUri: (uri: string) => string | null;
  log?: (msg: string) => void;
  onVisualState?: (state: VisualState | null) => void;
  onTree?: (tree: ReturnType<typeof buildTreeView> | null) => void;
  /** Dev only: hook para dumpear VisualState en JSON (shortcut/botón). */
  onVisualStateSnapshot?: (state: VisualState | null) => void;
}

export type CoreCapabilities = {
  hasReliableLocs: boolean;
  canRename: boolean;
  canNavigate: boolean;
};

const HAS_PROCESS = typeof process !== "undefined" && !!process?.on;
const IS_DEV = HAS_PROCESS && process.env?.NODE_ENV !== "production";

export class CoreHost {
  private bus = new SimpleEventBus();
  private lastSnapshot: DocumentSnapshot | null = null;
  private diagnostics: Diagnostic[] = [];
  private lastVisualState: VisualState | null = null;
  private index: NodeIndex | null = null;
  private tree: ReturnType<typeof buildTreeView> | null = null;
  private commands = new CommandBus();
  private lastRenameResult: RenameResult | null = null;
  private docChangedCount = 0;
  private syntaxPassCount = 0;
  private semanticPassCount = 0;
  private unsubscribe: (() => void) | null = null;
  private depsUpdateCount = 1;
  private disposed = false;
  private lastDocumentUri: string | null = null;
  private exitWarn?: () => void;
  private capabilities: CoreCapabilities = {
    hasReliableLocs: false,
    canRename: false,
    canNavigate: false,
  };

  constructor(private deps: CoreHostDeps) {
    if (HAS_PROCESS && IS_DEV) {
      this.exitWarn = () => {
        if (!this.disposed) {
          console.warn("[vexa-core-host] dispose() no fue llamado antes de terminar el proceso");
        }
      };
      process.on("exit", this.exitWarn);
    }

    attachDiagnosticLifecycle(this.bus);
    attachSyntaxPass(this.bus);
    attachSemanticPass(this.bus);

    attachDiagnosticsBridge(this.bus, {
      publishDiagnostics: (uri, diags, version) =>
        this.deps.publishDiagnostics(uri, diags, version),
    });

    this.unsubscribe = this.bus.subscribe((e) => {
      if (e.type === "documentChanged") {
        this.docChangedCount++;
        this.lastSnapshot = e.document;
        if (
          IS_DEV &&
          this.lastDocumentUri &&
          this.lastDocumentUri !== e.document.document.uri
        ) {
          console.warn(
            "[vexa-core-host] documentChanged con un URI distinto sin recreate/dispose; preferí un host nuevo por documento"
          );
        }
        this.lastDocumentUri = e.document.document.uri;
        this.diagnostics = [];
        this.index = new NodeIndex(e.document.ast as any);
        this.tree = buildTreeView(this.index.getAll());
        this.deps.onTree?.(this.tree);
        const sg = (e.document as any).semantic?.scopeGraph ?? [];
        const missingLoc = sg.some(
          (s: any) => s?.loc?.start?.offset == null || s?.loc?.end?.offset == null
        );
        this.deps.log?.(
          `[vexa] docChanged #${this.docChangedCount} (ast nodes: ${
            this.index.getAll().length
          }, scopeGraph: ${sg.length}, missingLoc=${missingLoc})`
        );
        this.updateCapabilities("documentChanged");
      }
      if (e.type === "diagnosticEmitted") {
        this.diagnostics.push(e.diagnostic);
      }
      if (e.type === "diagnosticsCleared") {
        if (!e.source) {
          this.diagnostics = [];
        } else {
          this.diagnostics = this.diagnostics.filter((d) => d.source !== e.source);
        }
      }
      if (e.type === "selectionChanged" || e.type === "hoverChanged") {
        this.lastVisualState = e.state;
        const selPath = e.state.selection?.path ?? "null";
        const rp: any = e.state.renamePreview;
        const ins: any = (e.state as any).inspection;
        const scopeId = ins?.scope?.scope?.id ?? null;
        if (rp?.symbolName) {
          this.deps.log?.(
            `[vexa] sel=${selPath} renamePreview: ${rp.symbolName} refs=${rp.references?.length ?? 0} scope=${scopeId}`
          );
        } else {
          this.deps.log?.(`[vexa] sel=${selPath} renamePreview: null scope=${scopeId}`);
        }
        this.updateCapabilities("visualState");
        this.deps.onVisualState?.(this.lastVisualState);
        if (IS_DEV && this.deps.onVisualStateSnapshot) {
          this.deps.onVisualStateSnapshot(this.lastVisualState);
        }
      }
      if (e.type === "syntaxPassCompleted") {
        this.syntaxPassCount++;
        this.deps.log?.(
          `[vexa] syntaxPassCompleted #${this.syntaxPassCount} (diags: ${e.diagnostics?.length ?? 0})`
        );
      }
      if (e.type === "semanticPassCompleted") {
        this.semanticPassCount++;
        this.deps.log?.(
          `[vexa] semanticPassCompleted #${this.semanticPassCount} (diags: ${e.diagnostics?.length ?? 0})`
        );
      }
    });

    attachInteractionController(this.bus, {
      getSnapshot: () => this.lastSnapshot!,
      getIndex: () => this.index!,
      getTree: () => this.tree!,
    });

    this.commands.register(
      "rename.apply",
      createRenameApplyCommand(this.bus, {
        getState: () => this.lastVisualState as any,
        getDocumentUri: () => this.lastSnapshot?.document.uri ?? "",
        onApply: (r) => {
          this.lastRenameResult = r;
        },
      })
    );
  }

  emit(event: CoreInputEvent) {
    this.bus.emit(event as any);
  }

  onDocumentChanged(snapshot: DocumentSnapshot) {
    this.bus.emit({ type: "documentChanged", document: snapshot } as any);
  }

  onCursorMoved(offset: number): VisualState | null {
    if (!this.lastSnapshot) return null;
    this.bus.emit({ type: "cursorMoved", offset });
    return this.lastVisualState;
  }

  getLastSnapshot() {
    return this.lastSnapshot;
  }

  getDiagnostics() {
    return this.diagnostics;
  }

  getLastVisualState() {
    return this.lastVisualState;
  }

  getCapabilities(): CoreCapabilities {
    return this.capabilities;
  }

  updateDeps(next: Partial<CoreHostDeps>) {
    this.depsUpdateCount++;
    if (IS_DEV) {
      if (this.depsUpdateCount > 1) {
        console.warn("[vexa-core-host] updateDeps() llamado más de una vez (dev warning)");
      }
      if (this.docChangedCount > 0) {
        console.warn("[vexa-core-host] updateDeps() se está llamando tarde (después de documentChanged)");
      }
      if (this.disposed) {
        console.warn("[vexa-core-host] updateDeps() después de dispose()");
      }
    }
    this.deps = { ...this.deps, ...next };
  }

  runRename(newName: string): RenameResult | null {
    this.lastRenameResult = null;
    this.commands.dispatch({ id: "rename.apply", payload: { newName } });
    return this.lastRenameResult;
  }

  reset() {
    this.lastSnapshot = null;
    this.diagnostics = [];
    this.lastVisualState = null;
    this.index = null;
    this.tree = null;
    this.lastDocumentUri = null;
    this.lastRenameResult = null;
    this.docChangedCount = 0;
    this.syntaxPassCount = 0;
    this.semanticPassCount = 0;
    this.deps.onVisualState?.(null);
    this.deps.onTree?.(null);
  }

  dispose() {
    if (this.disposed) {
      if (IS_DEV) {
        console.warn("[vexa-core-host] dispose() llamado dos veces");
      }
      return;
    }
    this.disposed = true;
    this.reset();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (HAS_PROCESS && this.exitWarn) {
      process.off("exit", this.exitWarn);
      this.exitWarn = undefined;
    }
  }

  private updateCapabilities(reason: "documentChanged" | "visualState") {
    const hasLocs =
      !!this.index &&
      this.index.getAll().length > 0 &&
      !this.index
        .getAll()
        .some((n) => n.loc?.start?.offset == null || n.loc?.end?.offset == null || (n.loc as any).estimated);

    const canRename = hasLocs && !!this.lastVisualState?.renamePreview;
    const canNavigate = hasLocs;

    const next: CoreCapabilities = { hasReliableLocs: hasLocs, canRename, canNavigate };
    const changed =
      next.hasReliableLocs !== this.capabilities.hasReliableLocs ||
      next.canRename !== this.capabilities.canRename ||
      next.canNavigate !== this.capabilities.canNavigate;

    if (changed) {
      this.capabilities = next;
      if (this.deps.log) {
        this.deps.log(
          `[vexa] capabilities update (${reason}): locs=${next.hasReliableLocs} rename=${next.canRename} navigate=${next.canNavigate}`
        );
      }
    }
  }
}

export * from "./protocol.js";
export default CoreHost;
