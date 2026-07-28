import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ClipboardCopy,
  Eye,
  EyeOff,
  RefreshCcw,
  RotateCcw,
  Save,
  Send,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import {
  UI_COMPONENT_CATALOG,
  createDefaultUiLayout,
  moveUiSection,
  normalizeUiLayout,
  type UiLayout,
  type UiLayoutVersion,
  type UiSection,
} from '@/lib/ui-layout';
import { cn } from '@/lib/utils';

const PAGE_KEY = 'settings' as const;

type ApiBody = {
  layout?: UiLayout;
  draft?: UiLayoutVersion | null;
  published?: UiLayoutVersion | null;
  versions?: UiLayoutVersion[];
};

const T = {
  title: '\uAD00\uB9AC\uC790 UI \uD3B8\uC9D1',
  adminOnly: '\uAD00\uB9AC\uC790\uB9CC \uC774\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.',
  loadFailed: '\uC11C\uBC84 \uBC30\uCE58\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.',
  saved: '\uCD08\uC548\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.',
  published: '\uD604\uC7AC \uBC30\uCE58\uB97C \uAC8C\uC2DC\uD588\uC2B5\uB2C8\uB2E4.',
  rolledBack: '\uC120\uD0DD\uD55C \uBC84\uC804\uC73C\uB85C \uB864\uBC31\uD588\uC2B5\uB2C8\uB2E4.',
  failed: '\uC694\uCCAD \uCC98\uB9AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.',
  save: '\uCD08\uC548 \uC800\uC7A5',
  publish: '\uAC8C\uC2DC',
  reset: '\uAE30\uBCF8 \uBC30\uCE58',
  versions: '\uC11C\uBC84 \uBC84\uC804',
  rollback: '\uB864\uBC31',
  instruction: 'ChatGPT \uC791\uC5C5\uC9C0\uC2DC\uBB38',
  copy: '\uBCF5\uC0AC',
};

async function request(
  path: string,
  method = 'GET',
  payload?: unknown,
): Promise<ApiBody> {
  const headers = new Headers();
  if (payload !== undefined) headers.set('Content-Type', 'application/json');

  const response = await authorizedFetch(`/api/admin/ui-layouts${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as ApiBody & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(body.error ?? `HTTP_${response.status}`);
  }

  return body;
}

export default function AdminUiBuilderPage() {
  const auth = useAuth();
  const [, navigate] = useLocation();
  const [layout, setLayout] = useState<UiLayout>(() =>
    createDefaultUiLayout(PAGE_KEY),
  );
  const [versions, setVersions] = useState<UiLayoutVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const catalog = useMemo(
    () =>
      new Map(
        UI_COMPONENT_CATALOG[PAGE_KEY].map((item) => [item.component, item]),
      ),
    [],
  );

  const load = async () => {
    setLoading(true);
    try {
      const body = await request(`/${PAGE_KEY}`);
      const selected =
        body.draft?.layout ??
        body.published?.layout ??
        body.layout ??
        createDefaultUiLayout(PAGE_KEY);
      setLayout(normalizeUiLayout(selected, PAGE_KEY));
      setVersions(body.versions ?? []);
      setSelectedVersionId(body.draft?.id ?? body.published?.id ?? null);
      setStatus('');
    } catch {
      setLayout(createDefaultUiLayout(PAGE_KEY));
      setStatus(T.loadFailed);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (auth.isAdmin) void load();
  }, [auth.isAdmin]);

  const updateSection = (id: string, patch: Partial<UiSection>) => {
    setLayout((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === id ? { ...section, ...patch } : section,
      ),
    }));
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      const body = await request(`/${PAGE_KEY}/draft`, 'POST', { layout });
      setVersions(body.versions ?? versions);
      setSelectedVersionId(body.draft?.id ?? selectedVersionId);
      setStatus(T.saved);
    } catch (error) {
      setStatus(`${T.failed} ${error instanceof Error ? error.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      await request(`/${PAGE_KEY}/publish`, 'POST', {
        layout,
        versionId: selectedVersionId,
        version_id: selectedVersionId,
      });
      setStatus(T.published);
      await load();
    } catch (error) {
      setStatus(`${T.failed} ${error instanceof Error ? error.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (versionId: string) => {
    setBusy(true);
    try {
      await request(`/${PAGE_KEY}/rollback`, 'POST', {
        versionId,
        version_id: versionId,
      });
      setStatus(T.rolledBack);
      await load();
    } catch (error) {
      setStatus(`${T.failed} ${error instanceof Error ? error.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const instruction = useMemo(
    () =>
      [
        '\uAE30\uC874 \uC8FC\uC2DD \uC571 \uAD00\uB9AC\uC790 UI \uD3B8\uC9D1 \uC791\uC5C5\uC744 \uC9C4\uD589\uD55C\uB2E4.',
        '\uB300\uC0C1 \uD654\uBA74: settings',
        '\uBE0C\uB79C\uCE58: feature/admin-ui-builder-20260728',
        '\uC6B4\uC601 /opt/stock-app \uC9C1\uC811 \uC218\uC815 \uBC0F \uC7AC\uC2DC\uC791 \uAE08\uC9C0',
        '\uC2E4\uC8FC\uBB38\u00B7\uC790\uB3D9\uB9E4\uB9E4 \uBCC0\uACBD \uAE08\uC9C0',
        '',
        ...layout.sections.map((section, index) => {
          const item = catalog.get(section.component);
          return `${index + 1}. ${item?.label ?? section.component} | visible=${section.visible} | width=${section.width} | height=${section.height} | spacing=${section.spacing}`;
        }),
      ].join('\n'),
    [catalog, layout],
  );

  if (!auth.isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <p className="text-center text-base font-black">{T.adminOnly}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-md items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-card-border"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="flex-1 text-xl font-black">{T.title}</h1>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy || loading}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-card-border disabled:opacity-50"
          >
            <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-28">
        {status ? (
          <p className="rounded-2xl border border-card-border bg-card p-3 text-sm font-bold">
            {status}
          </p>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => void saveDraft()}
            disabled={busy}
            className="flex items-center justify-center gap-1 rounded-2xl bg-primary p-3 text-xs font-black text-primary-foreground disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {T.save}
          </button>
          <button
            type="button"
            onClick={() => void publish()}
            disabled={busy}
            className="flex items-center justify-center gap-1 rounded-2xl border border-positive/40 bg-positive/10 p-3 text-xs font-black text-positive disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {T.publish}
          </button>
          <button
            type="button"
            onClick={() => setLayout(createDefaultUiLayout(PAGE_KEY))}
            disabled={busy}
            className="flex items-center justify-center gap-1 rounded-2xl border border-card-border bg-card p-3 text-xs font-black disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4" />
            {T.reset}
          </button>
        </div>

        {layout.sections.map((section, index) => {
          const definition = catalog.get(section.component);
          return (
            <section
              key={section.id}
              className={cn(
                'rounded-3xl border border-card-border bg-card p-4',
                !section.visible && 'opacity-60',
              )}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-black">
                    {definition?.label ?? section.component}
                  </p>
                  <p className="mt-1 text-xs font-bold text-muted-foreground">
                    {definition?.description}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() =>
                    setLayout((current) =>
                      moveUiSection(current, section.id, -1),
                    )
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-card-border disabled:opacity-30"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={index === layout.sections.length - 1}
                  onClick={() =>
                    setLayout((current) =>
                      moveUiSection(current, section.id, 1),
                    )
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-card-border disabled:opacity-30"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              </div>

              <button
                type="button"
                onClick={() =>
                  updateSection(section.id, { visible: !section.visible })
                }
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-card-border py-2 text-xs font-black"
              >
                {section.visible ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <EyeOff className="h-4 w-4" />
                )}
                {section.visible ? '\uD45C\uC2DC \uC911' : '\uC228\uAE40 \uC911'}
              </button>

              <input
                value={section.title ?? ''}
                onChange={(event) =>
                  updateSection(section.id, { title: event.target.value })
                }
                className="mt-3 w-full rounded-xl border border-card-border bg-background px-3 py-2 text-sm font-bold"
              />

              <div className="mt-3 grid grid-cols-3 gap-2">
                <select
                  value={section.width}
                  onChange={(event) =>
                    updateSection(section.id, {
                      width: event.target.value as UiSection['width'],
                    })
                  }
                  className="rounded-xl border border-card-border bg-background p-2 text-xs font-bold"
                >
                  <option value="full">full</option>
                  <option value="half">half</option>
                </select>
                <select
                  value={section.height}
                  onChange={(event) =>
                    updateSection(section.id, {
                      height: event.target.value as UiSection['height'],
                    })
                  }
                  className="rounded-xl border border-card-border bg-background p-2 text-xs font-bold"
                >
                  <option value="auto">auto</option>
                  <option value="compact">compact</option>
                  <option value="tall">tall</option>
                </select>
                <select
                  value={section.spacing}
                  onChange={(event) =>
                    updateSection(section.id, {
                      spacing: event.target.value as UiSection['spacing'],
                    })
                  }
                  className="rounded-xl border border-card-border bg-background p-2 text-xs font-bold"
                >
                  <option value="none">none</option>
                  <option value="sm">sm</option>
                  <option value="md">md</option>
                  <option value="lg">lg</option>
                </select>
              </div>
            </section>
          );
        })}

        <details className="rounded-3xl border border-card-border bg-card p-4">
          <summary className="cursor-pointer font-black">{T.versions}</summary>
          <div className="mt-3 space-y-2">
            {versions.map((version) => (
              <div
                key={version.id}
                className="flex items-center gap-2 rounded-2xl border border-card-border p-3"
              >
                <button
                  type="button"
                  onClick={() => {
                    setLayout(normalizeUiLayout(version.layout, PAGE_KEY));
                    setSelectedVersionId(version.id);
                  }}
                  className="min-w-0 flex-1 text-left text-sm font-black"
                >
                  v{version.version} / {version.status}
                </button>
                <button
                  type="button"
                  onClick={() => void rollback(version.id)}
                  disabled={busy}
                  className="rounded-xl border border-primary/40 px-3 py-2 text-xs font-black text-primary"
                >
                  {T.rollback}
                </button>
              </div>
            ))}
          </div>
        </details>

        <details className="rounded-3xl border border-card-border bg-card p-4">
          <summary className="cursor-pointer font-black">{T.instruction}</summary>
          <textarea
            readOnly
            value={instruction}
            className="mt-3 min-h-64 w-full rounded-2xl border border-card-border bg-background p-3 text-xs font-semibold"
          />
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(instruction).then(() => {
                setStatus('\uC791\uC5C5\uC9C0\uC2DC\uBB38\uC744 \uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4.');
              })
            }
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-sm font-black text-primary"
          >
            <ClipboardCopy className="h-4 w-4" />
            {T.copy}
          </button>
        </details>
      </main>

      <BottomNav />
    </div>
  );
}
