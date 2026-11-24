// Conversa com a IA pelo terminal, como se fosse um cliente no WhatsApp.
// Uso: node scripts/conversar.mjs [nome-do-cliente]
// Comandos: /reiniciar apaga a conversa simulada; /sair encerra.
// Lê SIMULADOR_URL e SIMULADOR_CHAVE de .env.local (fora do git).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const ambiente = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((linha) => linha.includes("="))
    .map((linha) => [linha.slice(0, linha.indexOf("=")), linha.slice(linha.indexOf("=") + 1)]),
);

const cliente = process.argv[2] ?? "teste";

async function enviar(corpo) {
  const resposta = await fetch(ambiente.SIMULADOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-simulador-chave": ambiente.SIMULADOR_CHAVE },
    body: JSON.stringify({ cliente, ...corpo }),
  });
  return resposta.json();
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Conversando como "${cliente}". /reiniciar apaga a conversa, /sair encerra.\n`);

while (true) {
  const mensagem = (await terminal.question("Você: ")).trim();
  if (!mensagem) continue;
  if (mensagem === "/sair") break;
  if (mensagem === "/reiniciar") {
    await enviar({ reiniciar: true });
    console.log("(conversa apagada)\n");
    continue;
  }

  const resultado = await enviar({ mensagem });
  if (resultado.erro) {
    console.log(`(erro: ${resultado.erro})\n`);
    continue;
  }
  for (const ferramenta of resultado.ferramentas ?? []) {
    console.log(`  [${ferramenta.nome}] ${JSON.stringify(ferramenta.entrada)}`);
  }
  for (const texto of resultado.respostas ?? []) console.log(`\nLFG: ${texto}`);
  if (!resultado.ia_ativa) console.log("\n(o corretor assumiu; a IA não responde mais)");
  const { status, temperatura } = resultado.lead ?? {};
  console.log(`\n  situação: ${status} · temperatura: ${temperatura ?? "-"}\n`);
}
terminal.close();
