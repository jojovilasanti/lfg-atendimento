// Ajudas do módulo de Locação: CPF/CNPJ, papéis e listas de opções.
// A mesma conferência de CPF/CNPJ existe no banco (interno.documento_valido).

export const soDigitos = (texto) => String(texto ?? "").replace(/\D/g, "");

export function documentoValido(texto) {
  const d = soDigitos(texto);
  if (d.length === 11) {
    if (/^(\d)\1{10}$/.test(d)) return false;
    const digito = (n) => {
      let soma = 0;
      for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
      const resto = (soma * 10) % 11;
      return resto === 10 ? 0 : resto;
    };
    return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
  }
  if (d.length === 14) {
    if (/^(\d)\1{13}$/.test(d)) return false;
    const digito = (n) => {
      const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const soma = pesos.reduce((s, p, i) => s + p * Number(d[i]), 0);
      const resto = soma % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    return digito(12) === Number(d[12]) && digito(13) === Number(d[13]);
  }
  return false;
}

// 52998224725 → 529.982.247-25; 11222333000181 → 11.222.333/0001-81
export function formatarDocumento(texto) {
  const d = soDigitos(texto);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return texto ?? "";
}

// Enquanto digita: põe pontos e traço conforme o tamanho.
export function mascaraDocumento(texto) {
  const d = soDigitos(texto).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})\.(\d{3})(\d)/, "$1.$2.$3").replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4");
  }
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, "$1.$2.$3/$4-$5");
}

export const PAPEIS = [
  ["locador", "Locador"],
  ["locatario", "Locatário"],
  ["fiador", "Fiador"],
  ["procurador", "Procurador"],
];
export const NOME_DO_PAPEL = Object.fromEntries(PAPEIS);

export const ESTADOS_CIVIS = [
  ["solteiro", "Solteiro(a)"],
  ["casado", "Casado(a)"],
  ["uniao_estavel", "União estável"],
  ["divorciado", "Divorciado(a)"],
  ["separado", "Separado(a)"],
  ["viuvo", "Viúvo(a)"],
];

export const GARANTIAS = [
  ["fiador", "Fiador"],
  ["seguro_fianca_vista", "Seguro fiança à vista"],
  ["seguro_fianca_parcelado", "Seguro fiança parcelado com o aluguel"],
  ["deposito", "Depósito de garantia"],
  ["caucao", "Caução"],
  ["cartao_credito", "Cartão de crédito"],
  ["titulo_capitalizacao", "Título de capitalização"],
  ["carta_fianca", "Carta fiança"],
];

export const percentual = (n) => `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 4 })}%`;
