## Vexa Core Host

Pequeño wrapper reutilizable para hosts (VS Code, Electron, etc.) que conecta el core de VEXA con una UI.

### Ciclo de vida
- `reset()`: limpia snapshot, diagnostics, visualState, tree y notifica `onVisualState(null)` / `onTree(null)`. Útil en HMR o al recargar un documento.
- `dispose()`: llama a `reset()` y desuscribe del bus. Usalo solo si no vas a reutilizar la instancia.

### Dependencias (`updateDeps`)
- `publishDiagnostics`, `getTextForUri` y callbacks opcionales (`log`, `onVisualState`, `onTree`) se inyectan al crear el host.
- En dev, si llamás `updateDeps()` más de una vez se loguea una advertencia. En prod no pasa nada.
- La UI no debe mutar VisualState: solo leerlo desde `onVisualState`.

### Contratos que expone
- `VisualState` (solo lectura): único estado que la UI debe consumir.
- `tree` (buildTreeView del core): estructura estable para TreeView; la UI no recalcula paths.
- `editorApi` (fuera de este paquete): bridge UI→editor (revealOffset/range); no va al core.

### Guardrails
- Diagnósticos sin `loc` no son navegables; la UI debe ignorar clicks en ese caso.
- `VisualState` puede ser `null`; la UI debe tener empty states seguros.
- Tree puede ser `null` o vacío; mostrá un mensaje, no falles.
