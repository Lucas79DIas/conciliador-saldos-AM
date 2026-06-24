import { useState, useCallback } from "react";
import JSZip from "jszip";

const C = {
  bg: "#0d1117", surface: "#161b22", card: "#1c2128", border: "#30363d",
  text: "#e6edf3", sub: "#8b949e", muted: "#484f58",
  green: "#7ee787", red: "#f85149", orange: "#f0883e", blue: "#58a6ff",
};

// ───────────────────────── Helpers numéricos (padrão EXT: vírgula decimal, C/D) ─────────────────────────
function parseBR(str) {
  if (str === undefined || str === null) return 0;
  const s = String(str).trim();
  if (!s) return 0;
  return parseFloat(s.replace(/\./g, "").replace(",", "."));
}

function formatBR(num) {
  return num.toFixed(2).replace(".", ",");
}

function signedValue(val, nat) {
  const v = parseBR(val);
  return (nat || "").trim().toUpperCase() === "C" ? -v : v;
}

function toNatural(signedNum) {
  const rounded = Math.round(signedNum * 100) / 100;
  if (rounded < 0) return { val: formatBR(Math.abs(rounded)), nat: "C" };
  return { val: formatBR(rounded), nat: "D" };
}

// ───────────────────────── Helpers CTB (vírgula decimal, sinal direto no número) ─────────────────────────
function parseNumberCTB(value) {
  if (!value) return 0;
  return parseFloat(String(value).replace(",", "."));
}

function formatNumberCTB(value) {
  return value.toFixed(2).replace(".", ",");
}

// ───────────────────────── CSV genérico ─────────────────────────
function parseCSV(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => line.split(";"));
}

function serializeCSV(rows) {
  return rows.map((r) => r.join(";")).join("\r\n") + "\r\n";
}

// ───────────────────────── Leitura de arquivos ─────────────────────────
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    // ISO-8859-1 / latin1, padrão dos arquivos do TCE
    reader.readAsText(file, "ISO-8859-1");
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function bufferToLatin1Text(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function isZipFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

// Resolve um arquivo (zip ou csv) para o texto do CSV de destino (targetName, ex: "EXT.CSV" ou "CTB.CSV").
// Se for zip, procura dentro pelo nome exato (case-insensitive). Se for csv direto, usa como está.
async function resolveTargetFile(file, targetName) {
  if (!isZipFile(file)) {
    const text = await readFileAsText(file);
    return { text, sourceName: file.name, fromZip: false };
  }

  const buffer = await readFileAsArrayBuffer(file);
  const zip = await JSZip.loadAsync(buffer);
  const allNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

  const candidates = allNames.filter((n) => {
    const base = n.toLowerCase().split("/").pop();
    return base === targetName.toLowerCase();
  });

  if (candidates.length === 0) {
    throw new Error(
      `Nenhum arquivo "${targetName.toUpperCase()}" encontrado dentro do ZIP "${file.name}". Arquivos disponíveis: ${allNames.join(", ") || "(zip vazio)"}`
    );
  }

  const chosen = candidates[0];
  const entry = zip.files[chosen];
  const contentBuffer = await entry.async("arraybuffer");
  const text = bufferToLatin1Text(contentBuffer);

  return { text, sourceName: chosen, fromZip: true };
}

// ───────────────────────── Lógica de correção: EXT ─────────────────────────
// Critério de chave: conta;fonte (apenas linhas tipo 20)
// Substitui saldo inicial pelo saldo final do mês anterior, absorvendo a diferença
// no débito (ou, se ficasse negativo, no crédito), preservando o saldo final.
function processEXT(prevText, currText) {
  const prevRows = parseCSV(prevText);
  const currRows = parseCSV(currText);

  const prevMap = {};
  for (const r of prevRows) {
    if (r[0] !== "20") continue;
    const key = `${r[2]};${r[3]}`;
    prevMap[key] = signedValue(r[9], r[10]);
  }

  const rows = currRows.map((r) => [...r]);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[0] !== "20") continue;

    const key = `${r[2]};${r[3]}`;
    if (!(key in prevMap)) continue;

    const siOrig = signedValue(r[5], r[6]);
    const debOrig = parseBR(r[7]);
    const credOrig = parseBR(r[8]);

    const novoSi = prevMap[key];
    const diff = novoSi - siOrig;

    if (Math.abs(diff) < 0.005) continue;

    let novoDeb = debOrig - diff;
    let novoCred = credOrig;
    if (novoDeb < 0) {
      novoCred = credOrig + Math.abs(novoDeb);
      novoDeb = 0;
    }

    const { val: siVal, nat: siNat } = toNatural(novoSi);
    rows[i][5] = siVal;
    rows[i][6] = siNat;
    rows[i][7] = formatBR(novoDeb);
    rows[i][8] = formatBR(novoCred);
    // saldo final (colunas 9/10) permanece inalterado
  }

  return serializeCSV(rows);
}

// ───────────────────────── Lógica de correção: CTB ─────────────────────────
// Critério de chave: conta;fonte;composeSaldo (apenas linhas tipo 20)
// Corrige saldo inicial para o saldo final do mês anterior e lança a diferença
// como movimentação tipo 21 (característica "99" — TRANSFERENCIA FINANCEIRA),
// consolidando com movimentações 99 já existentes em vez de duplicá-las.
function parseRecordCTB(line) {
  const parts = line.split(";");
  if (parts[0] === "20") {
    return {
      type: "20", orgao: parts[1], conta: parts[2], fonte: parts[3],
      composeSaldo: parts[4], saldoInicial: parts[5], saldoFinal: parts[6],
      rawLine: line,
    };
  } else if (parts[0] === "21") {
    return {
      type: "21", conta: parts[1], fonte: parts[2], movId: parts[3],
      movType: parts[4], characteristic: parts[5], description: parts[6],
      composeSaldo: parts[7], value: parts[8], rawLine: line,
    };
  }
  return null;
}

function buildRecordLineCTB(record) {
  if (record.type === "20") {
    return `20;${record.orgao};${record.conta};${record.fonte};${record.composeSaldo};${record.saldoInicial};${record.saldoFinal}`;
  } else if (record.type === "21") {
    return `21;${record.conta};${record.fonte};${record.movId};${record.movType};${record.characteristic};${record.description};${record.composeSaldo};${record.value}; ; ; ; `;
  }
  return record.rawLine;
}

function generateMovId() {
  return Math.floor(Math.random() * 10000000).toString();
}

function processCTB(prevText, currText) {
  const previousLines = prevText.split(/\r?\n/).filter((l) => l.trim());
  const currentLines = currText.split(/\r?\n/).filter((l) => l.trim());

  // Mapeia saldos finais do mês anterior
  const previousBalances = new Map();
  for (const line of previousLines) {
    const record = parseRecordCTB(line);
    if (record && record.type === "20") {
      const key = `${record.conta};${record.fonte};${record.composeSaldo}`;
      previousBalances.set(key, record.saldoFinal || "0");
    }
  }

  // Consolida movimentações 99 existentes (uma por conta;fonte;movType)
  const consolidatedMov99 = new Map();
  const seenMov99Keys = new Set();
  for (const line of currentLines) {
    const record = parseRecordCTB(line);
    if (record && record.type === "21" && record.characteristic === "99") {
      const movTypeKey = `${record.conta};${record.fonte};${record.movType}`;
      const value = parseNumberCTB(record.value || "0");
      if (seenMov99Keys.has(movTypeKey)) {
        consolidatedMov99.get(movTypeKey).value += value;
      } else {
        consolidatedMov99.set(movTypeKey, {
          movId: record.movId || "",
          value,
          composeSaldo: record.composeSaldo,
          description: record.description || "",
        });
        seenMov99Keys.add(movTypeKey);
      }
    }
  }

  // Identifica divergências de saldo inicial
  const adjustments = [];
  for (const line of currentLines) {
    const record = parseRecordCTB(line);
    if (record && record.type === "20") {
      const key = `${record.conta};${record.fonte};${record.composeSaldo}`;
      const saldoFinalAnterior = previousBalances.get(key) || "0";
      const saldoInicialOriginal = parseNumberCTB(record.saldoInicial || "0");
      const saldoFinalAnteriorNum = parseNumberCTB(saldoFinalAnterior);

      if (saldoInicialOriginal !== saldoFinalAnteriorNum) {
        const difference = saldoInicialOriginal - saldoFinalAnteriorNum;
        const movType = difference > 0 ? "1" : "2";
        adjustments.push({
          conta: record.conta, fonte: record.fonte, composeSaldo: record.composeSaldo,
          saldoFinalAnterior, saldoInicialOriginal: record.saldoInicial || "0",
          difference: formatNumberCTB(Math.abs(difference)), movType,
        });
      }
    }
  }

  const adjustmentsByKey = new Map();
  for (const adj of adjustments) {
    const key = `${adj.conta};${adj.fonte};${adj.composeSaldo}`;
    adjustmentsByKey.set(key, adj);
  }

  // Processa o arquivo: corrige saldo inicial, consolida/atualiza linhas 99
  const processedLines = [];
  const processedMov99Keys = new Set();

  for (const line of currentLines) {
    const record = parseRecordCTB(line);

    if (record && record.type === "20") {
      const key = `${record.conta};${record.fonte};${record.composeSaldo}`;
      const adjustment = adjustmentsByKey.get(key);
      if (adjustment) {
        record.saldoInicial = adjustment.saldoFinalAnterior;
      }
      processedLines.push(buildRecordLineCTB(record));
    } else if (record && record.type === "21" && record.characteristic === "99") {
      const movTypeKey = `${record.conta};${record.fonte};${record.movType}`;
      if (!processedMov99Keys.has(movTypeKey)) {
        const consolidated = consolidatedMov99.get(movTypeKey);
        const key = `${record.conta};${record.fonte};${record.composeSaldo}`;
        const adjustment = adjustmentsByKey.get(key);

        let finalValue = consolidated.value;
        if (adjustment && record.movType === adjustment.movType) {
          finalValue += parseNumberCTB(adjustment.difference);
        }

        const updatedRecord = { ...record, value: formatNumberCTB(finalValue), movId: consolidated.movId };
        processedLines.push(buildRecordLineCTB(updatedRecord));
        processedMov99Keys.add(movTypeKey);
      }
      // pula duplicadas
    } else {
      processedLines.push(line);
    }
  }

  // Adiciona movimentações 99 novas para ajustes sem movimentação existente
  const finalLines = [];
  const createdMov99Keys = new Set();

  for (const line of processedLines) {
    const record = parseRecordCTB(line);
    finalLines.push(line);

    if (record && record.type === "20") {
      const key = `${record.conta};${record.fonte};${record.composeSaldo}`;
      const adjustment = adjustmentsByKey.get(key);
      if (adjustment) {
        const movTypeKey = `${record.conta};${record.fonte};${adjustment.movType}`;
        if (!consolidatedMov99.has(movTypeKey) && !createdMov99Keys.has(movTypeKey)) {
          const newMov = {
            type: "21", orgao: record.orgao, conta: record.conta, fonte: record.fonte,
            movId: generateMovId(), movType: adjustment.movType, characteristic: "99",
            description: "TRANSFERENCIA FINANCEIRA", composeSaldo: record.composeSaldo,
            value: adjustment.difference,
          };
          finalLines.push(buildRecordLineCTB(newMov));
          createdMov99Keys.add(movTypeKey);
        }
      }
    }
  }

  return finalLines.join("\r\n") + "\r\n";
}

// ───────────────────────── Componentes de UI ─────────────────────────
function Btn({ onClick, children, secondary, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 22px",
        borderRadius: 6,
        border: secondary ? `1px solid ${C.border}` : "none",
        background: disabled ? C.muted : secondary ? "transparent" : C.green,
        color: secondary ? C.text : "#0d1117",
        fontWeight: 600,
        fontSize: 14,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
      {title && <h2 style={{ fontSize: 16, color: C.text, marginTop: 0, marginBottom: 16, fontWeight: 600 }}>{title}</h2>}
      {children}
    </div>
  );
}

function Checkbox({ checked, onChange, label, accent, description }) {
  return (
    <label
      style={{
        display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer",
        padding: "14px 16px", borderRadius: 8,
        border: `1px solid ${checked ? accent : C.border}`,
        background: checked ? accent + "11" : "transparent",
        flex: 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, marginTop: 2, accentColor: accent, cursor: "pointer" }}
      />
      <div>
        <div style={{ fontWeight: 600, fontSize: 15, color: checked ? accent : C.text }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{description}</div>}
      </div>
    </label>
  );
}

function FileDrop({ label, fileName, onFile, accent }) {
  const inputId = `file-${label.replace(/\s+/g, "-")}`;
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      style={{
        border: `2px dashed ${fileName ? accent : C.border}`,
        borderRadius: 10,
        padding: "24px 18px",
        textAlign: "center",
        background: fileName ? accent + "11" : "transparent",
        cursor: "pointer",
      }}
      onClick={() => document.getElementById(inputId).click()}
    >
      <input
        id={inputId}
        type="file"
        accept=".csv,.CSV,.zip,.ZIP"
        style={{ display: "none" }}
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <div style={{ fontSize: 13, color: C.sub, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 15, color: fileName ? accent : C.muted, fontWeight: 600 }}>
        {fileName || "Clique ou arraste o ZIP ou CSV"}
      </div>
    </div>
  );
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=iso-8859-1" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ───────────────────────── App principal ─────────────────────────
export default function App() {
  const [doExt, setDoExt] = useState(true);
  const [doCtb, setDoCtb] = useState(false);

  const [prevFile, setPrevFile] = useState(null);
  const [currFile, setCurrFile] = useState(null);

  const [prevRaw, setPrevRaw] = useState(null); // File object
  const [currRaw, setCurrRaw] = useState(null);

  const [results, setResults] = useState(null); // { ext: csvString, ctb: csvString }
  const [resultMeta, setResultMeta] = useState({}); // { ext: {sourceName, fromZip}, ctb: {...} }
  const [error, setError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [step, setStep] = useState(1);

  const handlePrevFile = useCallback((file) => {
    setError(null);
    setResults(null);
    setPrevFile(file.name);
    setPrevRaw(file);
  }, []);

  const handleCurrFile = useCallback((file) => {
    setError(null);
    setResults(null);
    setCurrFile(file.name);
    setCurrRaw(file);
  }, []);

  const processFiles = useCallback(async () => {
    setError(null);
    setProcessing(true);
    try {
      const out = {};
      const meta = {};

      if (doExt) {
        const prevResolved = await resolveTargetFile(prevRaw, "EXT.CSV");
        const currResolved = await resolveTargetFile(currRaw, "EXT.CSV");
        meta.ext = currResolved;
        out.ext = processEXT(prevResolved.text, currResolved.text);
      }

      if (doCtb) {
        const prevResolved = await resolveTargetFile(prevRaw, "CTB.CSV");
        const currResolved = await resolveTargetFile(currRaw, "CTB.CSV");
        meta.ctb = currResolved;
        out.ctb = processCTB(prevResolved.text, currResolved.text);
      }

      setResultMeta(meta);
      setResults(out);
      setStep(3);
    } catch (e) {
      setError(e.message);
    } finally {
      setProcessing(false);
    }
  }, [doExt, doCtb, prevRaw, currRaw]);

  const canContinue = (doExt || doCtb) && prevRaw && currRaw;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif", padding: "32px 16px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 12, color: C.blue, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>GFI Tech</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>Conciliador EXT / CTB — Saldo Inicial</h1>
          <p style={{ color: C.sub, fontSize: 14, marginTop: 6 }}>
            Envie o pacote (ZIP) ou CSV do mês anterior e do mês atual. Marque qual(is) conciliação(ões) deseja rodar.
          </p>
        </div>

        {/* Progress */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {[1, 2, 3].map((s) => (
            <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: step >= s ? C.green : C.border }} />
          ))}
        </div>

        {/* STEP 1: Seleção + Upload */}
        {step === 1 && (
          <Card title="1 · Selecionar conciliações e enviar arquivos">
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              <Checkbox
                checked={doExt}
                onChange={setDoExt}
                label="Conciliar EXT"
                description="Extrato bancário — saldo inicial via conta;fonte"
                accent={C.blue}
              />
              <Checkbox
                checked={doCtb}
                onChange={setDoCtb}
                label="Conciliar CTB"
                description="Contábil — saldo inicial via conta;fonte;composeSaldo"
                accent={C.orange}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <FileDrop
                label="Pacote do mês ANTERIOR"
                fileName={prevFile}
                onFile={handlePrevFile}
                accent={C.blue}
              />
              <FileDrop
                label="Pacote do mês ATUAL"
                fileName={currFile}
                onFile={handleCurrFile}
                accent={C.green}
              />
            </div>

            <p style={{ color: C.muted, fontSize: 12, marginTop: 14 }}>
              Pode enviar o ZIP completo da prestação de contas — a aplicação localiza automaticamente o(s) arquivo(s) EXT.CSV e/ou CTB.CSV dentro dele. Também aceita os CSVs soltos.
            </p>

            <div style={{ marginTop: 20 }}>
              <Btn onClick={processFiles} disabled={!canContinue || processing}>
                {processing ? "Processando…" : "Processar →"}
              </Btn>
            </div>
          </Card>
        )}

        {/* STEP 3: Resultado */}
        {step === 3 && results && (
          <Card title="2 · Arquivos corrigidos">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {results.ext && (
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  border: `1px solid ${C.blue}44`, background: C.blue + "11",
                  borderRadius: 8, padding: "14px 18px",
                }}>
                  <div>
                    <div style={{ fontWeight: 600, color: C.blue }}>EXT_CORRIGIDO.CSV</div>
                    {resultMeta?.ext?.fromZip && (
                      <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                        extraído de: {resultMeta.ext.sourceName}
                      </div>
                    )}
                  </div>
                  <Btn onClick={() => downloadCSV(results.ext, "EXT_CORRIGIDO.CSV")}>⬇ Baixar</Btn>
                </div>
              )}

              {results.ctb && (
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  border: `1px solid ${C.orange}44`, background: C.orange + "11",
                  borderRadius: 8, padding: "14px 18px",
                }}>
                  <div>
                    <div style={{ fontWeight: 600, color: C.orange }}>CTB_CORRIGIDO.CSV</div>
                    {resultMeta?.ctb?.fromZip && (
                      <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                        extraído de: {resultMeta.ctb.sourceName}
                      </div>
                    )}
                  </div>
                  <Btn onClick={() => downloadCSV(results.ctb, "CTB_CORRIGIDO.CSV")}>⬇ Baixar</Btn>
                </div>
              )}
            </div>

            <div style={{ marginTop: 20 }}>
              <Btn onClick={() => { setStep(1); setResults(null); }} secondary>← Novo processamento</Btn>
            </div>
          </Card>
        )}

        {error && (
          <div style={{ background: C.red + "15", border: `1px solid ${C.red}44`, borderRadius: 8, padding: 16, color: C.red, marginTop: 16 }}>
            ⚠ {error}
          </div>
        )}
      </div>
    </div>
  );
}
