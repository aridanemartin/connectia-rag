# Project Conventions

## Type Organization

**All interfaces, type aliases, and `as const` enums MUST live in a dedicated `.types.ts` file.**

- Each module directory (e.g., `src/rag/`, `src/documents/`) should have a `<module>.types.ts` file alongside its implementation files.
- Implementation files (`.ts`) must NOT contain `interface` or `type` declarations — import them from the `.types.ts` file instead.
- Constants derived from types (e.g., `as const` arrays used to derive union types) also belong in the `.types.ts` file.

### Example

**Wrong** — types defined in an implementation file:
```ts
// src/rag/question.service.ts
interface QuestionRequest {
  query: string;
  topK: number;
}

export async function askQuestion(req: QuestionRequest) { ... }
```

**Correct** — types extracted to a dedicated file:
```ts
// src/rag/rag.types.ts
export interface QuestionRequest {
  query: string;
  topK: number;
}
```
```ts
// src/rag/question.service.ts
import type { QuestionRequest } from "./rag.types.js";

export async function askQuestion(req: QuestionRequest) { ... }
```

### Naming Convention

| Pattern | Example |
|---|---|
| Single-module types | `rag.types.ts`, `config.types.ts` |
| Multi-entity types | `document.types.ts` |
| Shared types | `src/shared/shared.types.ts` |

### Rules

1. One `.types.ts` file per module directory — consolidate all types for that module in one place.
2. Use `export type` / `export interface` — types must be importable.
3. Class definitions (including custom Error classes) may stay in implementation files OR move to `.types.ts` if they are purely structural/data types with no logic.
4. If a type is used across multiple modules, place it in `src/shared/shared.types.ts`.
5. Always use `import type { ... }` when importing from `.types.ts` files.
