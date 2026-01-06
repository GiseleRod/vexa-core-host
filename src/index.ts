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
  publishDiagnostics: (uri: string, diags: any[]) => void;
  // Reservado para hosts con UI (hover/rename necesitan texto por URI).
  getTextForUri: (uri: string) => string | null;
  log?: (msg: string) => void;
  onVisualState?: (state: VisualState | null) => void;
  onTree?: (tree: ReturnType<typeof buildTreeView> | null) => void;
}

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

  constructor(private deps: CoreHostDeps) {
    attachDiagnosticLifecycle(this.bus);
    attachSyntaxPass(this.bus);
    attachSemanticPass(this.bus);

    attachDiagnosticsBridge(this.bus, {
      publishDiagnostics: (uri, diags) => this.deps.publishDiagnostics(uri, diags),
    });

    this.unsubscribe = this.bus.subscribe((e) => {
      if (e.type === "documentChanged") {
        this.docChangedCount++;
        this.lastSnapshot = e.document;
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
      if (e.type === "selectionChanged") {
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
        this.deps.onVisualState?.(this.lastVisualState);
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

  updateDeps(next: Partial<CoreHostDeps>) {
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
    this.lastRenameResult = null;
    this.docChangedCount = 0;
    this.syntaxPassCount = 0;
    this.semanticPassCount = 0;
    this.deps.onVisualState?.(null);
    this.deps.onTree?.(null);
  }

  dispose() {
    this.reset();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

export * from "./protocol.js";
export default CoreHost;
