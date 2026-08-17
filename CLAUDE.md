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

## Class Documentation

**Every class MUST have a TSDoc comment describing its responsibility.**

- Use `/** ... */` blocks above the class declaration, not `// ...` single-line comments.
- Include `@param`, `@returns`, and `@throws` tags where they add clarity, but keep the description concise (one to a few sentences of purpose plus tag lines).
- Document the class's key public methods and constructor if not obvious from the name.

### Example

**Wrong** — undocumented class:
```ts
export class QuestionService {
  constructor(private readonly deps: QuestionServiceDependencies) {}
  async ask(question: string): Promise<QuestionResponse> { ... }
}
```

**Correct** — TSDoc describing responsibility:
```ts
/**
 * Answers grounded questions: embeds the query, searches the vector store
 * over allowed versions, has the model decide an answer, validates citations
 * with one repair attempt, and records diagnostics. Key method: ask(...).
 */
export class QuestionService {
  constructor(private readonly deps: QuestionServiceDependencies) {}
  async ask(question: string): Promise<QuestionResponse> { ... }
}
```

## Folder Structure

The project intentionally keeps domain-based folder grouping (e.g.
`src/rag/question.service.ts` colocated with `src/rag/rag.types.ts`,
`src/diagnostics/diagnostics.service.ts` colocated with
`diagnostics.types.ts`) rather than a type-based `src/services/` folder that
would scatter cohesive modules and fight the `.types.ts`-per-module
convention. Do not propose a top-level `src/services/` reorg — service
classes live in their domain modules alongside their types.
