// Números de WhatsApp ficam só com dígitos e com o DDI 55.
// A Meta identifica alguns celulares do Brasil sem o 9 depois do DDD (o número
// chega com 12 dígitos em vez de 13); quem compara números usa as duas formas.

export function normalizarWhatsapp(entrada: string): string | null {
  let digitos = entrada.replace(/\D/g, "");
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  return /^55\d{10,11}$/.test(digitos) ? digitos : null;
}

// 556799990000 ou 5567999990000 → (67) 99999-0000
export function telefoneLegivel(numero: string): string {
  const completo = variantesWhatsapp(numero).find((n) => /^55\d{11}$/.test(n));
  return completo ? `(${completo.slice(2, 4)}) ${completo.slice(4, 9)}-${completo.slice(9)}` : numero;
}

export function variantesWhatsapp(numero: string): string[] {
  const digitos = numero.replace(/\D/g, "");
  if (/^55\d{2}9\d{8}$/.test(digitos)) return [digitos, digitos.slice(0, 4) + digitos.slice(5)];
  if (/^55\d{10}$/.test(digitos)) return [digitos, `${digitos.slice(0, 4)}9${digitos.slice(4)}`];
  return [digitos];
}
