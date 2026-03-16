export function generateQRCode(lotCode: string, date: Date, medicationName: string, dosage: string, sequence?: number): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  const dateStr = `${month}${day}${year}`;
  const medCode = medicationName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 4).toUpperCase().padEnd(4, 'X');
  const doseNum = dosage.replace(/[^0-9.]/g, '').split('.')[0].padStart(2, '0').substring(0, 2);
  const baseCode = `${lotCode.toUpperCase()}-${dateStr}-${medCode}-${doseNum}`;
  if (sequence !== undefined && sequence > 0) return `${baseCode}-${String(sequence).padStart(2, '0')}`;
  return baseCode;
}

export function parseDosage(dosage: string): { strength: number; strengthUnit: string } {
  const cleanDosage = dosage.trim();
  const match = cleanDosage.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z/]+)?$/);
  if (match) return { strength: parseFloat(match[1]), strengthUnit: match[2] || 'unit' };
  const complexMatch = cleanDosage.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/);
  if (complexMatch) return { strength: parseFloat(complexMatch[1]), strengthUnit: complexMatch[2] };
  return { strength: 0, strengthUnit: 'unit' };
}
