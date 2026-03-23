import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const bookRoot = path.join(repoRoot, "deeplearningbook");
const contentsRoot = path.join(bookRoot, "contents");
const outputRoot = path.join(bookRoot, "output");
const chapterOutputRoot = path.join(outputRoot, "chapters");
const mergedPdfPath = path.join(outputRoot, "deeplearningbook-complete.pdf");

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function removeExistingPdfOutputs(dirPath) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".pdf"))
      .map((entry) => fs.unlink(path.join(dirPath, entry))),
  );
}

async function getChapterOrder() {
  const indexPath = path.join(bookRoot, "index.html");
  const indexHtml = await fs.readFile(indexPath, "utf8");
  const hrefRegex = /href="(contents\/[^"]+\.html)"/g;
  const seen = new Set();
  const ordered = [];

  for (const match of indexHtml.matchAll(hrefRegex)) {
    const relPath = match[1];
    if (!seen.has(relPath)) {
      seen.add(relPath);
      ordered.push(relPath);
    }
  }

  if (ordered.length === 0) {
    throw new Error("No chapter HTML files found in deeplearningbook/index.html");
  }

  return ordered;
}

function qpdfMerge(pdfPaths, outputPath) {
  const result = spawnSync(
    "qpdf",
    ["--empty", "--pages", ...pdfPaths, "--", outputPath],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    throw new Error(`qpdf merge failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function main() {
  await ensureDir(outputRoot);
  await ensureDir(chapterOutputRoot);
  await removeExistingPdfOutputs(chapterOutputRoot);
  await fs.rm(mergedPdfPath, { force: true });

  const chapterPaths = await getChapterOrder();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 2200 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  const generatedPdfPaths = [];

  try {
    for (const [index, relPath] of chapterPaths.entries()) {
      const chapterPath = path.join(bookRoot, relPath);
      const chapterName = path.basename(relPath, ".html");
      const outputPdfPath = path.join(
        chapterOutputRoot,
        `${String(index + 1).padStart(2, "0")}-${chapterName}.pdf`,
      );

      console.log(`[${index + 1}/${chapterPaths.length}] Rendering ${relPath}`);

      await page.goto(pathToFileURL(chapterPath).href, {
        waitUntil: "load",
      });
      await page.waitForLoadState("networkidle");
      await page.evaluate(async () => {
        if (document.fonts?.ready) {
          await document.fonts.ready;
        }
      });

      await page.pdf({
        path: outputPdfPath,
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
          top: "0",
          right: "0",
          bottom: "0",
          left: "0",
        },
      });

      generatedPdfPaths.push(outputPdfPath);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(`Merging ${generatedPdfPaths.length} chapter PDFs`);
  qpdfMerge(generatedPdfPaths, mergedPdfPath);
  console.log(`Merged PDF written to ${mergedPdfPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
