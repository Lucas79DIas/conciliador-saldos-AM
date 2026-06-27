import { useState, useCallback } from "react";
import JSZip from "jszip";

const C = {
  bg: "#F5F6FA", surface: "#FFFFFF", card: "#FFFFFF", border: "#E6E8F0",
  text: "#1A1D29", sub: "#6B7280", muted: "#9CA3AF",
  green: "#16A34A", red: "#DC2626", orange: "#D97706",
  blue: "#3B5FE0", blueLight: "#EEF1FD", blueDark: "#2541B2",
  sidebar: "#FFFFFF", sidebarActive: "#F3F4F8",
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
  const rounded = Math.round(value * 100) / 100;
  const safe = rounded === 0 ? 0 : rounded; // evita "-0,00"
  return safe.toFixed(2).replace(".", ",");
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
// Contas que existiam no mês anterior (saldo final != 0) mas desapareceram no mês
// atual são recriadas já zeradas, com a movimentação necessária para chegar a zero.
function processEXT(prevText, currText) {
  const prevRows = parseCSV(prevText);
  const currRows = parseCSV(currText);

  const prevMap = {};
  const prevOrgao = {};
  for (const r of prevRows) {
    if (r[0] !== "20") continue;
    const key = `${r[2]};${r[3]}`;
    // Guarda o valor sinalizado E a natureza original (essencial quando o valor é zero,
    // já que 0 não tem sinal matemático mas o TCE distingue 0,00;C de 0,00;D)
    prevMap[key] = { signed: signedValue(r[9], r[10]), nat: (r[10] || "D").trim().toUpperCase() };
    prevOrgao[key] = r[1];
  }

  // Chaves conta;fonte presentes no mês atual (para detectar contas ausentes)
  const currentKeys = new Set();
  for (const r of currRows) {
    if (r[0] !== "20") continue;
    currentKeys.add(`${r[2]};${r[3]}`);
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

    const { signed: novoSi, nat: novoSiNatOriginal } = prevMap[key];
    const diff = novoSi - siOrig;

    if (Math.abs(diff) < 0.005) continue;

    let novoDeb = debOrig - diff;
    let novoCred = credOrig;
    if (novoDeb < 0) {
      novoCred = credOrig + Math.abs(novoDeb);
      novoDeb = 0;
    }

    // Natureza do novo saldo inicial: usa a natureza original do saldo final do mês
    // anterior quando o valor é zero (toNatural não distingue +0 de -0), senão deriva do sinal.
    const rounded = Math.round(novoSi * 100) / 100;
    const siVal = formatBR(Math.abs(rounded));
    const siNat = rounded === 0 ? novoSiNatOriginal : (rounded < 0 ? "C" : "D");

    rows[i][5] = siVal;
    rows[i][6] = siNat;
    rows[i][7] = formatBR(novoDeb);
    rows[i][8] = formatBR(novoCred);
    // saldo final (colunas 9/10) permanece inalterado
  }

  // Contas que existiam no mês anterior (saldo final != 0) e desapareceram no mês atual:
  // cria a linha 20 com saldo inicial = saldo final anterior, e débito/crédito
  // ajustados para zerar o saldo final, preservando a natureza original quando zero.
  for (const key in prevMap) {
    if (currentKeys.has(key)) continue; // já existe no mês atual, nada a fazer

    const { signed: saldoFinalAnterior, nat: natOriginal } = prevMap[key];
    if (Math.abs(saldoFinalAnterior) < 0.005) continue; // já era zero, não precisa recriar

    const [conta, fonte] = key.split(";");
    const orgao = prevOrgao[key] || "05";

    const rounded = Math.round(saldoFinalAnterior * 100) / 100;
    const siVal = formatBR(Math.abs(rounded));
    const siNat = rounded < 0 ? "C" : "D";

    // Para zerar o saldo: se saldo inicial positivo, lança no crédito (diminui);
    // se negativo, lança no débito (aumenta) — valor absoluto exato do saldo.
    let novoDeb = "0,00";
    let novoCred = "0,00";
    if (rounded > 0) {
      novoCred = formatBR(rounded);
    } else if (rounded < 0) {
      novoDeb = formatBR(Math.abs(rounded));
    }

    rows.push([
      "20", orgao, conta, fonte, " ",
      siVal, siNat,
      novoDeb, novoCred,
      "0,00", "D",
    ]);
  }

  return serializeCSV(rows);
}

// ───────────────────────── Lógica de correção: CTB ─────────────────────────
// Critério de chave: conta;fonte;composeSaldo (apenas linhas tipo 20)
// composeSaldo é o 5º campo da linha 20 (ex: "20;05;50344;1800000;2;...").
// Uma mesma conta;fonte pode ter múltiplas linhas 20 com composeSaldo diferente
// (ex: 1 e 2) representando saldos distintos — NUNCA somar entre composeSaldo diferentes.
// Corrige saldo inicial para o saldo final do mês anterior e lança a diferença
// como movimentação tipo 21 (característica "99" — TRANSFERENCIA FINANCEIRA),
// consolidando com movimentações 99 já existentes em vez de duplicá-las.
function parseRecordCTB(line) {
  const parts = line.split(";");
  if (parts[0] === "20") {
    return {
      type: "20", orgao: parts[1], conta: (parts[2] || "").trim(), fonte: (parts[3] || "").trim(),
      composeSaldo: parts[4], saldoInicial: parts[5], saldoFinal: parts[6],
      rawLine: line,
    };
  } else if (parts[0] === "21") {
    return {
      type: "21", conta: (parts[1] || "").trim(), fonte: (parts[2] || "").trim(), movId: parts[3],
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

  // Mapeia saldos finais do mês anterior (sempre normalizado com 2 casas decimais)
  // Guarda também o "orgao" original, necessário caso a conta precise ser recriada no mês atual.
  const previousBalances = new Map();
  const previousOrgao = new Map();
  for (const line of previousLines) {
    const record = parseRecordCTB(line);
    if (record && record.type === "20") {
      const key = `${record.conta};${record.fonte};${record.composeSaldo}`;
      previousBalances.set(key, formatNumberCTB(parseNumberCTB(record.saldoFinal || "0")));
      previousOrgao.set(key, record.orgao);
    }
  }

  // Chaves (conta;fonte;composeSaldo) presentes no mês atual — usado para detectar
  // contas que existiam no mês anterior mas desapareceram no mês atual.
  const currentKeys = new Set();
  for (const line of currentLines) {
    const record = parseRecordCTB(line);
    if (record && record.type === "20") {
      currentKeys.add(`${record.conta};${record.fonte};${record.composeSaldo}`);
    }
  }

  // Consolida movimentações 99 existentes (uma por conta;fonte;composeSaldo;movType)
  // IMPORTANTE: o composeSaldo aqui é o da PRÓPRIA linha 21 (campo nº8), não o da linha 20.
  // Uma mesma conta;fonte pode ter movimentações 99 associadas a composeSaldo=1 e composeSaldo=2
  // separadamente — jamais consolidar entre composeSaldo diferentes.
  const consolidatedMov99 = new Map();
  const seenMov99Keys = new Set();
  for (const line of currentLines) {
    const record = parseRecordCTB(line);
    if (record && record.type === "21" && record.characteristic === "99") {
      const movTypeKey = `${record.conta};${record.fonte};${record.composeSaldo};${record.movType}`;
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
      const saldoFinalAnterior = previousBalances.get(key) || "0,00";
      const saldoInicialOriginal = parseNumberCTB(record.saldoInicial || "0");
      const saldoFinalAnteriorNum = parseNumberCTB(saldoFinalAnterior);

      if (saldoInicialOriginal !== saldoFinalAnteriorNum) {
        const difference = saldoInicialOriginal - saldoFinalAnteriorNum;
        const movType = difference > 0 ? "1" : "2";
        adjustments.push({
          conta: record.conta, fonte: record.fonte, composeSaldo: record.composeSaldo,
          saldoFinalAnterior, saldoInicialOriginal: formatNumberCTB(saldoInicialOriginal),
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
      const movTypeKey = `${record.conta};${record.fonte};${record.composeSaldo};${record.movType}`;
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
        const movTypeKey = `${record.conta};${record.fonte};${record.composeSaldo};${adjustment.movType}`;
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

  // Contas que existiam no mês anterior (com saldo final ≠ 0) mas desapareceram no mês atual:
  // cria a linha 20 (saldo inicial = saldo final anterior, saldo final = 0,00) e a movimentação
  // 99 necessária para zerar o saldo, preservando a natureza/sinal do saldo anterior.
  for (const [key, saldoFinalAnteriorStr] of previousBalances) {
    if (currentKeys.has(key)) continue; // já existe no mês atual, nada a fazer aqui

    const saldoFinalAnteriorNum = parseNumberCTB(saldoFinalAnteriorStr);
    if (Math.abs(saldoFinalAnteriorNum) < 0.005) continue; // já era zero, não precisa recriar

    const [conta, fonte, composeSaldo] = key.split(";");
    const orgao = previousOrgao.get(key) || "05";

    // Movimentação necessária para zerar: se saldo positivo, precisa de SAÍDA (movType=2);
    // se negativo, precisa de ENTRADA (movType=1) — o inverso do sinal do saldo.
    const movType = saldoFinalAnteriorNum > 0 ? "2" : "1";
    const valorAbsoluto = formatNumberCTB(Math.abs(saldoFinalAnteriorNum));

    finalLines.push(buildRecordLineCTB({
      type: "20", orgao, conta, fonte, composeSaldo,
      saldoInicial: saldoFinalAnteriorStr, saldoFinal: "0,00",
    }));
    finalLines.push(buildRecordLineCTB({
      type: "21", orgao, conta, fonte,
      movId: generateMovId(), movType, characteristic: "99",
      description: "TRANSFERENCIA FINANCEIRA", composeSaldo,
      value: valorAbsoluto,
    }));
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
        borderRadius: 8,
        border: secondary ? `1px solid ${C.border}` : "none",
        background: disabled ? "#D1D5DB" : secondary ? "#FFFFFF" : C.blue,
        color: secondary ? C.text : "#FFFFFF",
        fontWeight: 600,
        fontSize: 14,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.7 : 1,
        boxShadow: secondary || disabled ? "none" : "0 1px 2px rgba(59,95,224,0.25)",
        transition: "background 0.15s ease",
      }}
    >
      {children}
    </button>
  );
}

function Card({ title, children }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
      padding: 24, marginBottom: 20,
      boxShadow: "0 1px 3px rgba(16,24,40,0.04)",
    }}>
      {title && <h2 style={{ fontSize: 16, color: C.text, marginTop: 0, marginBottom: 16, fontWeight: 700 }}>{title}</h2>}
      {children}
    </div>
  );
}

function Checkbox({ checked, onChange, label, accent, description }) {
  return (
    <label
      style={{
        display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer",
        padding: "14px 16px", borderRadius: 10,
        border: `1px solid ${checked ? accent : C.border}`,
        background: checked ? C.blueLight : "#FAFBFC",
        flex: 1,
        transition: "all 0.15s ease",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, marginTop: 2, accentColor: accent, cursor: "pointer" }}
      />
      <div>
        <div style={{ fontWeight: 600, fontSize: 15, color: checked ? C.blueDark : C.text }}>{label}</div>
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
        border: `2px dashed ${fileName ? accent : "#D5D9E3"}`,
        borderRadius: 12,
        padding: "24px 18px",
        textAlign: "center",
        background: fileName ? C.blueLight : "#FAFBFC",
        cursor: "pointer",
        transition: "all 0.15s ease",
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
      <div style={{ fontSize: 15, color: fileName ? C.blueDark : C.muted, fontWeight: 600 }}>
        {fileName || "Clique ou arraste o ZIP ou CSV"}
      </div>
    </div>
  );
}

function Badge({ children, color }) {
  return (
    <span style={{
      display: "inline-block", padding: "4px 12px", borderRadius: 6,
      background: color || C.blue, color: "#FFFFFF",
      fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
    }}>
      {children}
    </span>
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
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", display: "flex" }}>

      {/* ───────────── Sidebar ───────────── */}
      <div style={{
        width: 220, background: C.sidebar, borderRight: `1px solid ${C.border}`,
        display: "flex", flexDirection: "column", justifyContent: "space-between",
        position: "sticky", top: 0, height: "100vh", flexShrink: 0,
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "22px 20px 18px" }}>
            <div style={{
              width: 34, height: 34, borderRadius: 8, background: C.blue,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontWeight: 800, fontSize: 15, flexShrink: 0,
            }}>
              GFI
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text, lineHeight: 1.1 }}>Conciliador</div>
              <div style={{ fontSize: 11, color: C.blue, fontWeight: 500 }}>Saldos AM</div>
            </div>
          </div>

          <div style={{ height: 1, background: C.border, margin: "0 0 10px" }} />

          <nav style={{ padding: "0 10px", display: "flex", flexDirection: "column", gap: 2 }}>
            <SidebarItem icon="🧾" label="Conciliador" active />
          </nav>
        </div>

        <div style={{ padding: 16, borderTop: `1px solid ${C.border}` }}>
          <a href="https://gfitech.com.br/" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
              borderRadius: 10, background: C.blueLight, cursor: "pointer",
            }}>
              <div style={{
                width: 30, height: 30, borderRadius: "50%", background: C.blue,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontWeight: 700, fontSize: 12, flexShrink: 0,
              }}>
                GT
              </div>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.blueDark }}>GFI Tech</div>
                <div style={{ fontSize: 11, color: C.sub }}>ver ferramentas ↗</div>
              </div>
            </div>
          </a>
        </div>
      </div>

      {/* ───────────── Main content ───────────── */}
      <div style={{ flex: 1, minWidth: 0 }}>

        {/* Topbar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 32px", borderBottom: `1px solid ${C.border}`, background: "#fff",
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Conciliador EXT / CTB</div>
            <div style={{ fontSize: 13, color: C.sub, marginTop: 1 }}>Correção de saldo inicial 👋</div>
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "8px 16px",
            borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.sub, fontWeight: 500,
          }}>
            Prestação de contas
          </div>
        </div>

        <div style={{ padding: "28px 32px", maxWidth: 880 }}>

          {/* Progress */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            {[1, 2, 3].map((s) => (
              <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: step >= s ? C.blue : C.border }} />
            ))}
          </div>

          {/* STEP 1: Seleção + Upload */}
          {step === 1 && (
            <Card title="Selecionar conciliações e enviar arquivos">
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
                  accent={C.blue}
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
                  accent={C.blue}
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
            <Card title="Arquivos corrigidos">
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {results.ext && (
                  <div style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    border: `1px solid ${C.border}`, background: C.blueLight,
                    borderRadius: 10, padding: "14px 18px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <Badge color={C.blue}>EXT</Badge>
                      <div>
                        <div style={{ fontWeight: 600, color: C.text }}>EXT_CORRIGIDO.CSV</div>
                        {resultMeta?.ext?.fromZip && (
                          <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                            extraído de: {resultMeta.ext.sourceName}
                          </div>
                        )}
                      </div>
                    </div>
                    <Btn onClick={() => downloadCSV(results.ext, "EXT_CORRIGIDO.CSV")}>⬇ Baixar</Btn>
                  </div>
                )}

                {results.ctb && (
                  <div style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    border: `1px solid ${C.border}`, background: C.blueLight,
                    borderRadius: 10, padding: "14px 18px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <Badge color={C.blueDark}>CTB</Badge>
                      <div>
                        <div style={{ fontWeight: 600, color: C.text }}>CTB_CORRIGIDO.CSV</div>
                        {resultMeta?.ctb?.fromZip && (
                          <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                            extraído de: {resultMeta.ctb.sourceName}
                          </div>
                        )}
                      </div>
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
            <div style={{ background: "#FEF2F2", border: `1px solid #FCA5A5`, borderRadius: 10, padding: 16, color: C.red, marginTop: 16, fontSize: 14 }}>
              ⚠ {error}
            </div>
          )}

          <div style={{
            marginTop: 40, paddingTop: 18, borderTop: `1px solid ${C.border}`,
            textAlign: "center", fontSize: 13, color: C.muted,
          }}>
            Desenvolvido por <strong style={{ color: C.sub }}>GFI Tech</strong> ·{" "}
            <a
              href="https://gfitech.com.br/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: C.blue, textDecoration: "none", fontWeight: 600 }}
            >
              conheça nossas ferramentas ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({ icon, label, active }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
      borderRadius: 8, cursor: "pointer",
      background: active ? C.sidebarActive : "transparent",
      color: active ? C.text : C.sub,
      fontWeight: active ? 600 : 500,
      fontSize: 14,
    }}>
      <span style={{ fontSize: 15 }}>{icon}</span>
      {label}
    </div>
  );
}
