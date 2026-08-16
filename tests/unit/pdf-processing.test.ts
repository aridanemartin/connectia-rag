import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeExtractedText,
  PdfExtractor,
} from "../../src/documents/pdf-extractor.js";
import { TextChunker } from "../../src/documents/text-chunker.js";
import { createTestPdf } from "../support/create-test-pdf.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const UNICODE_WHITE_SPACE_CODE_POINTS =
  "\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
  "\u2028\u2029\u202F\u205F\u3000";
const TWENTY_SEMANTIC_UNICODE_CODE_POINTS = "áéíóúñüÁÉÍÓÚÑÜçÇóóó🎓";
const INTERRUPTING_NOISE = [
  { name: "BOM", value: "\uFEFF" },
  { name: "Cc", value: "\u0007" },
  { name: "Cf", value: "\u200B" },
] as const;
const WHITESPACE_SEPARATING_NOISE = [
  { name: "BOM U+FEFF", value: "\uFEFF" },
  { name: "Cc lower boundary U+0000", value: "\u0000" },
  { name: "Cc representative U+0007", value: "\u0007" },
  { name: "Cc C0 upper boundary U+001F", value: "\u001F" },
  { name: "Cc C1 lower boundary U+007F", value: "\u007F" },
  { name: "Cc upper boundary U+009F", value: "\u009F" },
  { name: "Cf BMP boundary U+00AD", value: "\u00AD" },
  { name: "Cf representative U+200B", value: "\u200B" },
  { name: "Cf range boundary U+206F", value: "\u206F" },
  { name: "Cf supplementary U+E0001", value: "\u{E0001}" },
] as const;
const metadata = {
  documentId: DOCUMENT_ID,
  versionId: VERSION_ID,
  documentTitle: "Matrícula 2026-2027",
  academicYear: "2026-2027",
};

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "connectia-pdf-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createMagicStub(contents = "%PDF-stub"): Promise<string> {
  const directory = await createTemporaryDirectory();
  const path = join(directory, "stub.pdf");
  await writeFile(path, contents);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("normalizeExtractedText", () => {
  it.each(WHITESPACE_SEPARATING_NOISE)(
    "collapses horizontal whitespace exposed by removing $name in one pass",
    ({ value }) => {
      const normalized = normalizeExtractedText(`El\t${value}\tplazo`);

      expect(normalized).toBe("El plazo");
      expect(normalizeExtractedText(normalized)).toBe(normalized);
    },
  );

  it.each(INTERRUPTING_NOISE)(
    "is final-NFC and idempotent after removing $name noise from decomposed accents",
    ({ value }) => {
      const input = `a${value}\u0301`.repeat(10);

      const normalized = normalizeExtractedText(input);

      expect(normalized).toBe("á".repeat(10));
      expect(normalized).toBe(normalized.normalize("NFC"));
      expect(normalizeExtractedText(normalized)).toBe(normalized);
    },
  );

  it("is idempotent for ordinary Spanish text and Unicode line structure", () => {
    const input =
      "  MATRÍCULA\u0085Informacio\u0301n\tacadémica.\u2028Continúa.\u2029Segundo párrafo.  ";
    const expected =
      "MATRÍCULA\nInformación académica.\nContinúa.\n\nSegundo párrafo.";

    const normalized = normalizeExtractedText(input);

    expect(normalized).toBe(expected);
    expect(normalizeExtractedText(normalized)).toBe(expected);
  });

  it.each([
    {
      name: "a Spanish heading, CRLF, decomposed accents, and mixed noise",
      input:
        "  MATRÍCULA\t\u0007\t2026  \r\nInformacio\uFEFF\u0301n\t\u200B\tacadémica.  ",
      expected: "MATRÍCULA 2026\nInformación académica.",
    },
    {
      name: "NEL, LS, PS, control boundaries, and format noise",
      input:
        "DOCUMENTACIÓN\u0085El\t\u007F\tplazo\u2028continu\u2060\u0301a.\u2029Segundo\t\u00AD\tpárrafo.",
      expected: "DOCUMENTACIÓN\nEl plazo\ncontinúa.\n\nSegundo párrafo.",
    },
    {
      name: "paragraph CRLF, supplementary format noise, and a C1 boundary",
      input: "BECAS\r\n\r\nRevisio\u{E0001}\u0301n\t\u009F\tfinal.",
      expected: "BECAS\n\nRevisión final.",
    },
    {
      name: "ordinary canonical Spanish headings and paragraph structure",
      input: "ADMISIÓN\nEl plazo continúa.\n\nSegundo párrafo.",
      expected: "ADMISIÓN\nEl plazo continúa.\n\nSegundo párrafo.",
    },
  ])("is a fixed point for $name", ({ input, expected }) => {
    const normalized = normalizeExtractedText(input);

    expect(normalized).toBe(expected);
    expect(normalized).toBe(normalized.normalize("NFC"));
    expect(normalizeExtractedText(normalized)).toBe(expected);
  });
});

describe("PdfExtractor", () => {
  it("extracts normalized Spanish text with trustworthy one-based page metadata", async () => {
    const directory = await createTemporaryDirectory();
    const path = await createTestPdf(directory, [
      ["MATRÍCULA", "El plazo termina el 15 de julio."],
      ["DOCUMENTACIÓN", "Debe presentarse el formulario firmado."],
    ]);

    const bytes = await readFile(path);
    const pages = await new PdfExtractor().extract(path);

    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pages).toEqual([
      {
        page: 1,
        text: "MATRÍCULA\nEl plazo termina el 15 de julio.",
      },
      {
        page: 2,
        text: "DOCUMENTACIÓN\nDebe presentarse el formulario firmado.",
      },
    ]);
  });

  it("normalizes whitespace while preserving useful paragraph and heading breaks", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent:
            "  MATRÍCULA  \r\nEl\tplazo termina.  \r\n\r\n\r\n  Segundo párrafo.  ",
          metadata: { loc: { pageNumber: 4 } },
        },
      ],
    }));

    await expect(extractor.extract(path)).resolves.toEqual([
      {
        page: 4,
        text: "MATRÍCULA\nEl plazo termina.\n\nSegundo párrafo.",
      },
    ]);
  });

  it("preserves Unicode line and paragraph structure while normalizing whitespace", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent:
            "  MATRÍCULA\u0085El   plazo\u2028continúa.\u2029Segundo párrafo.  ",
          metadata: { loc: { pageNumber: 4 } },
        },
      ],
    }));

    await expect(extractor.extract(path)).resolves.toEqual([
      {
        page: 4,
        text: "MATRÍCULA\nEl plazo\ncontinúa.\n\nSegundo párrafo.",
      },
    ]);
  });

  it("rejects a non-PDF signature before constructing the parser", async () => {
    const path = await createMagicStub("not-a-pdf");
    let parserConstructions = 0;
    const extractor = new PdfExtractor(() => {
      parserConstructions += 1;
      return { load: async () => [] };
    });

    await expect(extractor.extract(path)).rejects.toMatchObject({
      code: "PDF_SIGNATURE_INVALID",
      message: "El archivo no tiene una firma PDF válida.",
    });
    expect(parserConstructions).toBe(0);
  });

  it("classifies a valid-magic corrupt PDF without surfacing parser details", async () => {
    const path = await createMagicStub("%PDF-not-a-real-pdf");

    const extraction = new PdfExtractor().extract(path);

    await expect(extraction).rejects.toMatchObject({
      code: "PDF_CORRUPT",
      message: "El PDF está dañado y no se puede procesar.",
    });
    await extraction.catch((error: unknown) => {
      expect(String(error)).not.toContain(path);
      expect(String(error)).not.toContain("Invalid PDF structure");
    });
  });

  it("classifies encrypted PDFs without surfacing the parser error", async () => {
    const path = await createMagicStub();
    const parserError = new Error(`contraseña necesaria en ${path}`);
    parserError.name = "PasswordException";
    const extractor = new PdfExtractor(() => ({
      load: async () => {
        throw parserError;
      },
    }));

    const extraction = extractor.extract(path);

    await expect(extraction).rejects.toMatchObject({
      code: "PDF_ENCRYPTED",
      message: "El PDF está cifrado y no se puede procesar.",
    });
    await extraction.catch((error: unknown) => {
      expect(String(error)).not.toContain(path);
      expect(String(error)).not.toContain("contraseña necesaria");
    });
  });

  it("uses a distinct sanitized code for an unexpected parser failure", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => {
        throw new Error(`fallo interno al leer ${path}`);
      },
    }));

    const extraction = extractor.extract(path);

    await expect(extraction).rejects.toMatchObject({
      code: "PDF_PARSE_FAILED",
      message: "No se ha podido procesar el PDF.",
    });
    await extraction.catch((error: unknown) => {
      expect(String(error)).not.toContain(path);
      expect(String(error)).not.toContain("fallo interno");
    });
  });

  it("rejects malformed parser output with a sanitized parser code", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [null] as never,
    }));

    await expect(extractor.extract(path)).rejects.toMatchObject({
      code: "PDF_PARSE_FAILED",
      message: "No se ha podido procesar el PDF.",
    });
  });

  it("rejects missing or invalid parser page metadata rather than inferring an array index", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent: "Texto suficientemente largo para superar el mínimo.",
          metadata: { loc: { pageNumber: "1" } },
        },
      ],
    }));

    await expect(extractor.extract(path)).rejects.toMatchObject({
      code: "PDF_METADATA_INVALID",
      message: "El PDF no contiene metadatos de página válidos.",
    });
  });

  it("preserves non-contiguous page numbers from metadata and orders by those numbers", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent: "Contenido de la página siete para la prueba.",
          metadata: { loc: { pageNumber: 7 } },
        },
        {
          pageContent: "Contenido de la página tres para la prueba.",
          metadata: { loc: { pageNumber: 3 } },
        },
      ],
    }));

    const pages = await extractor.extract(path);

    expect(pages.map(({ page }) => page)).toEqual([3, 7]);
  });

  it("rejects a real textless PDF as scanned or effectively empty", async () => {
    const directory = await createTemporaryDirectory();
    const path = await createTestPdf(directory, [[]]);

    await expect(new PdfExtractor().extract(path)).rejects.toMatchObject({
      code: "PDF_TEXT_NOT_FOUND",
      message: "El PDF no contiene suficiente texto extraíble.",
    });
  });

  it("rejects every Unicode White_Space code point and BOM as parser noise", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent: `${UNICODE_WHITE_SPACE_CODE_POINTS.repeat(20)}${"\uFEFF".repeat(20)}`,
          metadata: { loc: { pageNumber: 1 } },
        },
      ],
    }));

    await expect(extractor.extract(path)).rejects.toMatchObject({
      code: "PDF_TEXT_NOT_FOUND",
    });
  });

  it("rejects 19 semantic characters even when Unicode whitespace and BOM add length", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent: `${"á".repeat(19)}${"\u0085".repeat(20)}${"\uFEFF".repeat(20)}`,
          metadata: { loc: { pageNumber: 1 } },
        },
      ],
    }));

    await expect(extractor.extract(path)).rejects.toMatchObject({
      code: "PDF_TEXT_NOT_FOUND",
    });
  });

  it("accepts and preserves exactly 20 semantic Unicode code points including an astral character", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent: "áéíóúñüÁÉÍÓÚÑÜçÇóóó\uFEFF🎓\u0085\u00A0",
          metadata: { loc: { pageNumber: 1 } },
        },
      ],
    }));

    expect(Array.from(TWENTY_SEMANTIC_UNICODE_CODE_POINTS)).toHaveLength(20);
    await expect(extractor.extract(path)).resolves.toEqual([
      { page: 1, text: TWENTY_SEMANTIC_UNICODE_CODE_POINTS },
    ]);
  });

  it.each(INTERRUPTING_NOISE)(
    "rejects 19 canonical Spanish characters interrupted by $name noise",
    async ({ value }) => {
      const path = await createMagicStub();
      const extractor = new PdfExtractor(() => ({
        load: async () => [
          {
            pageContent: `a${value}\u0301`.repeat(19),
            metadata: { loc: { pageNumber: 1 } },
          },
        ],
      }));

      await expect(extractor.extract(path)).rejects.toMatchObject({
        code: "PDF_TEXT_NOT_FOUND",
      });
    },
  );

  it.each(INTERRUPTING_NOISE)(
    "accepts exactly 20 canonical Spanish characters interrupted by $name noise",
    async ({ value }) => {
      const path = await createMagicStub();
      const extractor = new PdfExtractor(() => ({
        load: async () => [
          {
            pageContent: `a${value}\u0301`.repeat(20),
            metadata: { loc: { pageNumber: 1 } },
          },
        ],
      }));

      const pages = await extractor.extract(path);
      const chunks = await new TextChunker().split({ ...metadata, pages });

      expect(pages).toEqual([{ page: 1, text: "á".repeat(20) }]);
      expect(chunks.map(({ text }) => text)).toEqual(["á".repeat(20)]);
    },
  );
});

describe("TextChunker", () => {
  it("preserves real PDF pages and infers short uppercase headings on every chunk", async () => {
    const directory = await createTemporaryDirectory();
    const path = await createTestPdf(directory, [
      ["MATRÍCULA", "El plazo termina el 15 de julio."],
      ["DOCUMENTACIÓN", "Debe presentarse el formulario firmado."],
    ]);
    const pages = await new PdfExtractor().extract(path);

    const chunks = await new TextChunker().split({ ...metadata, pages });

    expect(chunks.map(({ page }) => page)).toEqual([1, 2]);
    expect(chunks.map(({ section }) => section)).toEqual([
      "MATRÍCULA",
      "DOCUMENTACIÓN",
    ]);
    expect(new Set(chunks.map(({ pointId }) => pointId)).size).toBe(
      chunks.length,
    );
  });

  it("uses null before a heading and the nearest preceding heading on the same page", async () => {
    const chunks = await new TextChunker().split({
      ...metadata,
      pages: [
        {
          page: 1,
          text: [
            "Este preámbulo no es un título.",
            "",
            "MATRÍCULA",
            "El plazo ordinario termina en julio.",
            "",
            "DOCUMENTACIÓN",
            "Se presenta el formulario firmado.",
          ].join("\n"),
        },
      ],
    });

    expect(chunks.map(({ section }) => section)).toEqual([
      null,
      "MATRÍCULA",
      "DOCUMENTACIÓN",
    ]);
  });

  it("keeps chunks isolated by page with contiguous global indexes", async () => {
    const chunks = await new TextChunker().split({
      ...metadata,
      pages: [
        { page: 1, text: "a".repeat(1_200) },
        { page: 2, text: "b".repeat(1_200) },
      ],
    });

    expect(chunks.map(({ page }) => page)).toEqual([1, 1, 2, 2]);
    expect(chunks.map(({ chunkIndex }) => chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(
      chunks
        .filter(({ page }) => page === 1)
        .every(({ text }) => !text.includes("b")),
    ).toBe(true);
    expect(
      chunks
        .filter(({ page }) => page === 2)
        .every(({ text }) => !text.includes("a")),
    ).toBe(true);
  });

  it("applies 1000-character chunks with 200-character overlap", async () => {
    const chunks = await new TextChunker().split({
      ...metadata,
      pages: [{ page: 1, text: "á".repeat(2_200) }],
    });

    expect(chunks.map(({ text }) => text.length)).toEqual([1_000, 1_000, 600]);
    expect(chunks[0]?.text.slice(-200)).toBe(chunks[1]?.text.slice(0, 200));
    expect(chunks[1]?.text.slice(-200)).toBe(chunks[2]?.text.slice(0, 200));
  });

  it("derives one stable version hash from normalized page content and fixed page joins", async () => {
    const chunks = await new TextChunker().split({
      ...metadata,
      pages: [
        { page: 2, text: "  DETALLE\r\nMás   texto. " },
        { page: 1, text: "INTRODUCCIÓN \nTexto   normalizado." },
      ],
    });

    expect(chunks.map(({ page }) => page)).toEqual([1, 2]);
    expect(new Set(chunks.map(({ contentHash }) => contentHash))).toEqual(
      new Set([
        "a6d45666cd0ba6676c43818b2f545db4ee53d7f5c0579ef67b3ccd4f9b004a6d",
      ]),
    );
    expect(chunks[0]?.pointId).toBe("9d6b37a8-637a-546e-ae90-1b4edf9f4646");
  });

  it("keeps content hashes stable for canonically equivalent noise-interrupted text", async () => {
    const chunker = new TextChunker();

    const canonical = await chunker.split({
      ...metadata,
      pages: [{ page: 1, text: "á".repeat(20) }],
    });
    const interrupted = await chunker.split({
      ...metadata,
      pages: [{ page: 1, text: "a\uFEFF\u0301".repeat(20) }],
    });

    expect(interrupted).toEqual(canonical);
  });

  it("produces identical payload text and hashes for whitespace/noise-equivalent Spanish input", async () => {
    const chunker = new TextChunker();

    const canonical = await chunker.split({
      ...metadata,
      pages: [{ page: 1, text: "MATRÍCULA\nEl plazo continúa." }],
    });
    const noisy = await chunker.split({
      ...metadata,
      pages: [
        {
          page: 1,
          text: "MATRÍCULA\nEl\t\u0007\tplazo continu\u200B\u0301a\uFEFF.",
        },
      ],
    });

    expect(canonical.map(({ text }) => text)).toEqual([
      "MATRÍCULA\nEl plazo continúa.",
    ]);
    expect(noisy.map(({ text }) => text)).toEqual(
      canonical.map(({ text }) => text),
    );
    expect(noisy.map(({ contentHash }) => contentHash)).toEqual(
      canonical.map(({ contentHash }) => contentHash),
    );
    expect(noisy).toEqual(canonical);
  });

  it("hashes exactly the canonical page text used for a single emitted chunk", async () => {
    const chunks = await new TextChunker().split({
      ...metadata,
      pages: [
        {
          page: 1,
          text: "El\t\u0007\tplazo continu\u200B\u0301a\uFEFF.",
        },
      ],
    });

    expect(chunks.map(({ text }) => text)).toEqual(["El plazo continúa."]);
    expect(new Set(chunks.map(({ contentHash }) => contentHash))).toEqual(
      new Set([
        "584d0fa23b4b4e9eceac6d5fb45d428011d1d2918ba212bf4e0f6c805d0fe871",
      ]),
    );
  });

  it("keeps hashes stable but changes every point ID when the version ID changes", async () => {
    const pages = [{ page: 1, text: "MATRÍCULA\nEl plazo termina en julio." }];
    const chunker = new TextChunker();

    const first = await chunker.split({ ...metadata, pages });
    const repeated = await chunker.split({ ...metadata, pages });
    const otherVersion = await chunker.split({
      ...metadata,
      versionId: OTHER_VERSION_ID,
      pages,
    });

    expect(repeated).toEqual(first);
    expect(otherVersion.map(({ contentHash }) => contentHash)).toEqual(
      first.map(({ contentHash }) => contentHash),
    );
    expect(otherVersion.map(({ pointId }) => pointId)).not.toEqual(
      first.map(({ pointId }) => pointId),
    );
  });

  it("rejects normalized empty chunks with a safe application code", async () => {
    await expect(
      new TextChunker().split({
        ...metadata,
        pages: [{ page: 1, text: " \r\n\t " }],
      }),
    ).rejects.toMatchObject({
      code: "PDF_CHUNK_EMPTY",
      message: "El PDF contiene un fragmento de texto vacío.",
    });
  });

  it("rejects chunks made only of Unicode whitespace, controls, and format characters", async () => {
    await expect(
      new TextChunker().split({
        ...metadata,
        pages: [
          {
            page: 1,
            text: "\u0085\u2028\u2029\u200B\u2060\u0007\uFEFF",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "PDF_CHUNK_EMPTY",
      message: "El PDF contiene un fragmento de texto vacío.",
    });
  });
});
