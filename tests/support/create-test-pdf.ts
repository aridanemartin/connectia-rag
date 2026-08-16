import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const TEST_DATE = new Date("2026-08-15T00:00:00.000Z");

export async function createTestPdf(
  directory: string,
  pages: readonly (readonly string[])[],
): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Documento institucional de prueba");
  pdf.setAuthor("Connectia");
  pdf.setCreator("Connectia");
  pdf.setProducer("Connectia");
  pdf.setCreationDate(TEST_DATE);
  pdf.setModificationDate(TEST_DATE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    lines.forEach((line, index) => {
      page.drawText(line, {
        x: 50,
        y: 780 - index * 28,
        size: index === 0 ? 16 : 12,
        font,
      });
    });
  }

  const path = join(directory, `${randomUUID()}.pdf`);
  await writeFile(path, await pdf.save({ useObjectStreams: false }));
  return path;
}
