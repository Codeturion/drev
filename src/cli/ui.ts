import chalk from 'chalk';
import ora from 'ora';
import readline from 'node:readline';

const CELL_MAX = 60;

export function info(msg: string): void {
  process.stdout.write(`${chalk.green('✓')} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stdout.write(`${chalk.yellow('!')} ${msg}\n`);
}

export function errorOut(msg: string): void {
  process.stderr.write(`${chalk.red('✗')} ${msg}\n`);
}

export interface Spinner {
  stop(): void;
  succeed(s?: string): void;
  fail(s?: string): void;
}

export function spinner(msg: string): Spinner {
  const s = ora(msg).start();
  return {
    stop: () => s.stop(),
    succeed: (text?: string) => s.succeed(text),
    fail: (text?: string) => s.fail(text),
  };
}

function truncate(value: string): string {
  if (value.length <= CELL_MAX) return value;
  return value.slice(0, CELL_MAX);
}

export function table(rows: Array<Record<string, string>>, columns: string[]): string {
  if (rows.length === 0) return '';

  const cells: string[][] = rows.map((row) =>
    columns.map((col) => {
      const raw = row[col];
      return truncate(typeof raw === 'string' ? raw : '');
    }),
  );

  const widths: number[] = columns.map((col, i) => {
    let w = col.length;
    for (const r of cells) {
      const cell = r[i] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });

  const renderRow = (parts: string[]): string =>
    parts.map((p, i) => p.padEnd(widths[i] ?? p.length)).join('  ').trimEnd();

  const lines: string[] = [];
  lines.push(renderRow(columns));
  for (const r of cells) {
    lines.push(renderRow(r));
  }
  return lines.join('\n');
}

export async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${prompt} [y/N] `, (a) => resolve(a));
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}
