import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIN_EXTRACTED_CHARACTERS,
  PdfExtractor,
} from "../../src/documents/pdf-extractor.js";
import { TextChunker } from "../../src/documents/text-chunker.js";
import { createTestPdf } from "../support/create-test-pdf.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_VERSION_ID = "22222222-2222-4222-8222-222222222222";
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
            "  MATRÍCULA  \r\n\tEl   plazo termina.  \r\n\r\n\r\n  Segundo párrafo.  ",
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

  it("rejects one non-whitespace character below the extraction threshold", async () => {
    const path = await createMagicStub();
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        {
          pageContent: "A".repeat(MIN_EXTRACTED_CHARACTERS - 1),
          metadata: { loc: { pageNumber: 1 } },
        },
      ],
    }));

    await expect(extractor.extract(path)).rejects.toMatchObject({
      code: "PDF_TEXT_NOT_FOUND",
    });
  });

  it("accepts exactly the minimum number of non-whitespace characters", async () => {
    const path = await createMagicStub();
    const text = "Á".repeat(MIN_EXTRACTED_CHARACTERS);
    const extractor = new PdfExtractor(() => ({
      load: async () => [
        { pageContent: text, metadata: { loc: { pageNumber: 1 } } },
      ],
    }));

    await expect(extractor.extract(path)).resolves.toEqual([{ page: 1, text }]);
  });
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
});
