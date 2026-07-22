/// <reference lib="webworker" />

const MAX_ROWS = 500;
const MAX_COLUMNS = 100;
const MAX_CELLS = 50_000;

self.onmessage = async (event: MessageEvent<{ requestId: number; bytes: ArrayBuffer; sheet?: string }>) => {
  const { requestId, bytes, sheet } = event.data;
  try {
    const { default: readXlsxFile, readSheetNames } = await import("read-excel-file/web-worker");
    const file = new File([bytes], "preview.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const sheets = await readSheetNames(file);
    const activeSheet = sheet && sheets.includes(sheet) ? sheet : sheets[0];
    const sourceRows = activeSheet ? await readXlsxFile(file, { sheet: activeSheet }) : [];
    const rows: unknown[][] = [];
    let cells = 0;
    let truncated = sourceRows.length > MAX_ROWS;
    for (const sourceRow of sourceRows.slice(0, MAX_ROWS)) {
      const row = sourceRow.slice(0, MAX_COLUMNS);
      if (sourceRow.length > MAX_COLUMNS || cells + row.length > MAX_CELLS) truncated = true;
      const remaining = MAX_CELLS - cells;
      if (remaining <= 0) break;
      rows.push(row.slice(0, remaining));
      cells += Math.min(row.length, remaining);
    }
    self.postMessage({ requestId, sheets, sheet: activeSheet ?? null, rows, truncated });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : "Could not read this workbook.",
    });
  }
};

export {};
