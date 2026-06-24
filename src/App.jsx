import { useState, useCallback } from "react";

const C = {
  bg: "#0d1117", surface: "#161b22", card: "#1c2128", border: "#30363d",
  text: "#e6edf3", sub: "#8b949e", muted: "#484f58",
  green: "#7ee787", red: "#f85149", orange: "#f0883e", blue: "#58a6ff",
};

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

function parseCSV(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => line.split(";"));
}

function serializeCSV(rows) {
  return rows.map((r) => r.join(";")).join("\r\n") + "\r\n";
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    // ISO-8859-1 / latin1, padrão dos arquivos do TCE
    reader.readAsText(file, "ISO-8859-1");
  });
}

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

function FileDrop({ label, fileName, onFile, accent }) {
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
        padding: "28px 20px",
        textAlign: "center",
        background: fileName ? accent + "11" : "transparent",
        cursor: "pointer",
        position: "relative",
      }}
      onClick={() => document.getElementById(`file-${label}`).click()}
    >
      <input
        id={`file-${label}`}
        type="file"
        accept=".csv,.CSV"
        style={{ display: "none" }}
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <div style={{ fontSize: 13, color: C.sub, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 15, color: fileName ? accent : C.muted, fontWeight: 600 }}>
        {fileName || "Clique ou arraste o CSV"}
      </div>
    </div>
  );
}

export default function App() {
  const [step, setStep] = useState(1);

  const [prevFile, setPrevFile] = useState(null);
  const [currFile, setCurrFile] = useState(null);
  const [prevRows, setPrevRows] = useState(null);
  const [currRows, setCurrRows] = useState(null);

  const [report, setReport] = useState(null); // [{conta, fonte, ...}]
  const [correctedCSV, setCorrectedCSV] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  const handlePrevFile = useCallback(async (file) => {
    setPrevFile(file.name);
    const text = await readFileAsText(file);
    setPrevRows(parseCSV(text));
  }, []);

  const handleCurrFile = useCallback(async (file) => {
    setCurrFile(file.name);
    const text = await readFileAsText(file);
    setCurrRows(parseCSV(text));
  }, []);

  const processFiles = useCallback(() => {
    setError(null);
    if (!prevRows || !currRows) return;

    // Mapear linhas tipo 20 do mês anterior por chave conta;fonte → saldo final (signed)
    const prevMap = {};
    for (const r of prevRows) {
      if (r[0] !== "20") continue;
      const conta = r[2];
      const fonte = r[3];
      const key = `${conta};${fonte}`;
      const sf = signedValue(r[9], r[10]);
      prevMap[key] = sf;
    }

    const rows = currRows.map((r) => [...r]);
    const rep = [];
    let matched = 0;
    let unmatched = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r[0] !== "20") continue;

      const conta = r[2];
      const fonte = r[3];
      const key = `${conta};${fonte}`;

      const siOrig = signedValue(r[5], r[6]);
      const debOrig = parseBR(r[7]);
      const credOrig = parseBR(r[8]);
      const sfOrig = signedValue(r[9], r[10]);

      if (!(key in prevMap)) {
        unmatched++;
        rep.push({
          conta, fonte, status: "sem_correspondencia",
          siOrigDisplay: `${formatBR(Math.abs(siOrig))} ${siOrig < 0 ? "C" : "D"}`,
          novoSiDisplay: "—",
          diffDisplay: "—",
        });
        continue;
      }

      const novoSi = prevMap[key];
      const diff = novoSi - siOrig;

      if (Math.abs(diff) < 0.005) {
        matched++;
        rep.push({
          conta, fonte, status: "sem_diferenca",
          siOrigDisplay: `${formatBR(Math.abs(siOrig))} ${siOrig < 0 ? "C" : "D"}`,
          novoSiDisplay: `${formatBR(Math.abs(novoSi))} ${novoSi < 0 ? "C" : "D"}`,
          diffDisplay: "0,00",
        });
        continue;
      }

      // Ajuste preferencial no débito (debOrig - diff); se ficar negativo, sobra vai pro crédito
      let novoDeb = debOrig - diff;
      let novoCred = credOrig;
      if (novoDeb < 0) {
        novoCred = credOrig + Math.abs(novoDeb);
        novoDeb = 0;
      }

      // Atualizar saldo inicial
      const { val: siVal, nat: siNat } = toNatural(novoSi);
      rows[i][5] = siVal;
      rows[i][6] = siNat;
      rows[i][7] = formatBR(novoDeb);
      rows[i][8] = formatBR(novoCred);
      // saldo final (coluna 9/10) permanece igual — não tocamos

      matched++;
      rep.push({
        conta, fonte, status: "ajustado",
        siOrigDisplay: `${formatBR(Math.abs(siOrig))} ${siOrig < 0 ? "C" : "D"}`,
        novoSiDisplay: `${siVal} ${siNat}`,
        diffDisplay: `${diff < 0 ? "−" : "+"}${formatBR(Math.abs(diff))}`,
        debOrig: formatBR(debOrig), novoDeb: formatBR(novoDeb),
        credOrig: formatBR(credOrig), novoCred: formatBR(novoCred),
        sfCheck: `${formatBR(Math.abs(sfOrig))} ${sfOrig < 0 ? "C" : "D"}`,
      });
    }

    setReport(rep);
    setCorrectedCSV(serializeCSV(rows));
    setStats({ total: rep.length, matched, unmatched, ajustados: rep.filter(r => r.status === "ajustado").length });
    setStep(3);
  }, [prevRows, currRows]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([correctedCSV], { type: "text/csv;charset=iso-8859-1" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "EXT_CORRIGIDO.CSV";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [correctedCSV]);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif", padding: "32px 16px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 12, color: C.blue, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>GFI Tech</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>Conciliador EXT — Saldo Inicial</h1>
          <p style={{ color: C.sub, fontSize: 14, marginTop: 6 }}>
            Substitui o saldo inicial do arquivo atual pelo saldo final do mês anterior, ajustando débito/crédito para preservar o saldo final.
          </p>
        </div>

        {/* Progress */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {[1, 2, 3].map((s) => (
            <div key={s} style={{
              flex: 1, height: 4, borderRadius: 2,
              background: step >= s ? C.green : C.border,
            }} />
          ))}
        </div>

        {/* STEP 1: Upload */}
        {step === 1 && (
          <Card title="1 · Enviar arquivos EXT">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <FileDrop label="EXT do mês ANTERIOR" fileName={prevFile} onFile={handlePrevFile} accent={C.blue} />
              <FileDrop label="EXT do mês ATUAL" fileName={currFile} onFile={handleCurrFile} accent={C.green} />
            </div>
            <div style={{ marginTop: 20 }}>
              <Btn onClick={() => setStep(2)} disabled={!prevRows || !currRows}>
                Continuar →
              </Btn>
            </div>
          </Card>
        )}

        {/* STEP 2: Confirmar */}
        {step === 2 && (
          <Card title="2 · Confirmar processamento">
            <p style={{ color: C.sub, fontSize: 14 }}>
              Mês anterior: <strong style={{ color: C.blue }}>{prevFile}</strong> ({prevRows.filter(r => r[0] === "20").length} linhas tipo 20)
            </p>
            <p style={{ color: C.sub, fontSize: 14 }}>
              Mês atual: <strong style={{ color: C.green }}>{currFile}</strong> ({currRows.filter(r => r[0] === "20").length} linhas tipo 20)
            </p>
            <p style={{ color: C.sub, fontSize: 13, marginTop: 16 }}>
              Critério de equivalência: <strong>conta;fonte</strong>. Apenas linhas tipo <strong>20</strong> serão alteradas; demais tipos (30, 31, 32...) permanecem intactos.
            </p>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <Btn onClick={() => setStep(1)} secondary>← Voltar</Btn>
              <Btn onClick={processFiles}>Processar →</Btn>
            </div>
          </Card>
        )}

        {/* STEP 3: Resultado */}
        {step === 3 && report && (
          <>
            <Card title="3 · Resultado da conciliação">
              <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                <Stat label="Total linhas tipo 20" value={stats.total} color={C.text} />
                <Stat label="Ajustadas" value={stats.ajustados} color={C.orange} />
                <Stat label="Sem diferença" value={stats.matched - stats.ajustados} color={C.green} />
                <Stat label="Sem correspondência" value={stats.unmatched} color={C.red} />
              </div>

              {stats.unmatched > 0 && (
                <div style={{ background: C.red + "15", border: `1px solid ${C.red}44`, borderRadius: 6, padding: "10px 14px", fontSize: 13, color: C.red, marginBottom: 16 }}>
                  ⚠ {stats.unmatched} conta(s);fonte(s) do mês atual não foram encontradas no mês anterior — mantidas sem alteração.
                </div>
              )}

              <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Conta", "Fonte", "Saldo Ini. (original)", "Saldo Ini. (novo)", "Diferença", "Status"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "6px 10px", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, borderBottom: `2px solid ${C.border}`, fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.map((r, i) => {
                      const color = r.status === "ajustado" ? C.orange : r.status === "sem_correspondencia" ? C.red : C.muted;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: "5px 10px" }}>{r.conta}</td>
                          <td style={{ padding: "5px 10px" }}>{r.fonte}</td>
                          <td style={{ padding: "5px 10px", color: C.sub, fontFamily: "monospace" }}>{r.siOrigDisplay}</td>
                          <td style={{ padding: "5px 10px", color: C.text, fontFamily: "monospace" }}>{r.novoSiDisplay}</td>
                          <td style={{ padding: "5px 10px", color, fontFamily: "monospace" }}>{r.diffDisplay}</td>
                          <td style={{ padding: "5px 10px", color, fontSize: 11 }}>
                            {r.status === "ajustado" ? "Ajustado" : r.status === "sem_diferenca" ? "Sem diferença" : "Sem correspondência"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <Btn onClick={() => setStep(1)} secondary>← Novo processamento</Btn>
                <Btn onClick={handleDownload}>⬇ Baixar EXT_CORRIGIDO.CSV</Btn>
              </div>
            </Card>
          </>
        )}

        {error && (
          <div style={{ background: C.red + "15", border: `1px solid ${C.red}44`, borderRadius: 8, padding: 16, color: C.red, marginTop: 16 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ flex: "1 1 140px", background: "#0d1117", border: `1px solid #30363d`, borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
