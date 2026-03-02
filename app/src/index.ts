import { serve } from '@hono/node-server';
import { format, isValid, parseISO } from 'date-fns';
import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { mkdir, stat, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PORT = 3000;
const DEFAULT_OUTPUT_DIR = process.cwd();

const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
const outputDir = path.resolve(process.env.OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR);

type CaptionPayload = {
  source: string;
  eventType: string;
  captionId: string;
  speaker: string;
  meetingUrl: string;
  meetingTitle: string;
  finalizedAt: string;
  lines: string[];
};

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type'],
    allowMethods: ['POST', 'OPTIONS']
  })
);

function splitLines(text: unknown): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatLocalTimestamp(input: string): string {
  const parsedIso = parseISO(input);
  const parsedDate = isValid(parsedIso) ? parsedIso : new Date(input);
  const date = isValid(parsedDate) ? parsedDate : new Date();

  return format(date, 'yyyy-MM-dd HH:mm:ss XXX');
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function resolveOutputFile(meetingTitle: string, firstTimestamp: string): string {
  const parsedIso = parseISO(firstTimestamp);
  const date = isValid(parsedIso) ? parsedIso : new Date();
  const dateStr = format(date, 'yyyy-MM-dd_HHmm');

  const title = sanitizeFileName(meetingTitle) || 'untitled';
  const fileName = `${dateStr}_${title}.md`;
  return path.resolve(outputDir, fileName);
}

function normalizePayload(payload: Record<string, unknown>): CaptionPayload {
  const source = String(payload.source ?? 'unknown');
  const eventType = String(payload.eventType ?? 'unknown');
  const captionId = String(payload.captionId ?? '');
  const speaker = String(payload.speaker ?? '');
  const meetingUrl = String(payload.meetingUrl ?? '');
  const meetingTitle = String(payload.meetingTitle ?? '');
  const finalizedAt = formatLocalTimestamp(String(payload.finalizedAt ?? new Date().toISOString()));

  const lines = Array.isArray(payload.lines)
    ? payload.lines.map((line) => String(line).trim()).filter(Boolean)
    : splitLines(payload.text);

  return {
    source,
    eventType,
    captionId,
    speaker,
    meetingUrl,
    meetingTitle,
    finalizedAt,
    lines
  };
}

async function ensureMarkdownFile(filePath: string, title: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const heading = title ? `# ${title}\n\n` : '# Meet Captions\n\n';

  try {
    const file = await stat(filePath);
    if (file.size === 0) {
      await writeFile(filePath, heading, 'utf8');
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    await writeFile(filePath, heading, 'utf8');
  }
}

const meetingFileMap = new Map<string, string>();

function getOutputFileForMeeting(payload: CaptionPayload): string {
  const meetingKey = payload.meetingUrl || 'default';

  const existing = meetingFileMap.get(meetingKey);
  if (existing) return existing;

  const filePath = resolveOutputFile(payload.meetingTitle, payload.finalizedAt);
  meetingFileMap.set(meetingKey, filePath);
  return filePath;
}

async function appendCaptionToMarkdown(payload: CaptionPayload): Promise<string> {
  const filePath = getOutputFileForMeeting(payload);
  await ensureMarkdownFile(filePath, payload.meetingTitle);

  await appendFile(filePath, `[${payload.finalizedAt}] ${payload.speaker}: ${payload.lines.join(' ')}\n`, 'utf8');
  return filePath;
}

app.post('/', async (c) => {
  try {
    const bodyBuffer = await c.req.arrayBuffer();

    const raw = Buffer.from(bodyBuffer).toString('utf8');
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    const payload = normalizePayload(parsed);

    if (payload.lines.length === 0) {
      return c.json({ ok: false, error: 'No caption lines' }, 422);
    }

    const filePath = await appendCaptionToMarkdown(payload);

    return c.json(
      {
        ok: true,
        appendedLines: payload.lines.length,
        file: filePath
      },
      200
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ ok: false, error: message }, 400);
  }
});

app.notFound((c) => c.json({ ok: false, error: 'Not Found' }, 404));

serve(
  {
    fetch: app.fetch,
    port,
  }
);
