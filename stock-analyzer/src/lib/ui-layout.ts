export const UI_LAYOUT_SCHEMA_VERSION = 1 as const;

export type UiPageKey = 'settings';
export type UiSectionWidth = 'full' | 'half';
export type UiSectionHeight = 'auto' | 'compact' | 'tall';
export type UiSectionSpacing = 'none' | 'sm' | 'md' | 'lg';

export type UiSection = {
  id: string;
  component: string;
  visible: boolean;
  order: number;
  width: UiSectionWidth;
  height: UiSectionHeight;
  spacing: UiSectionSpacing;
  title?: string;
};

export type UiLayout = {
  schemaVersion: typeof UI_LAYOUT_SCHEMA_VERSION;
  pageKey: UiPageKey;
  sections: UiSection[];
};

export type UiLayoutVersion = {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  layout: UiLayout;
  created_at?: string;
  published_at?: string | null;
};

export type UiComponentDefinition = {
  component: string;
  label: string;
  description: string;
};

export const UI_COMPONENT_CATALOG: Record<UiPageKey, UiComponentDefinition[]> = {
  settings: [
    {
      component: 'settings.account-assets',
      label: '\uACC4\uC815 \u00B7 \uC790\uC0B0',
      description: '\uB85C\uADF8\uC778\uACFC \uD3EC\uD2B8\uD3F4\uB9AC\uC624 \uC601\uC5ED',
    },
    {
      component: 'settings.screen',
      label: '\uD654\uBA74 \uC124\uC815',
      description: '\uB2E4\uD06C\uBAA8\uB4DC\uC640 \uD654\uBA74 \uD45C\uC2DC \uC124\uC815',
    },
    {
      component: 'settings.notifications',
      label: '\uD734\uB300\uD3F0 \uC54C\uB9BC',
      description: '\uBE0C\uB77C\uC6B0\uC800\uC640 \uD478\uC2DC \uC54C\uB9BC \uC601\uC5ED',
    },
    {
      component: 'settings.alert-types',
      label: '\uAD00\uC2EC\uC885\uBAA9 \uC54C\uB9BC \uC885\uB958',
      description: '\uB274\uC2A4\u00B7\uACF5\uC2DC\u00B7\uB4F1\uB77D\uB960 \uC54C\uB9BC \uC120\uD0DD',
    },
    {
      component: 'settings.ai-repair',
      label: 'AI \uBCF5\uAD6C\uC13C\uD130',
      description: '\uAD00\uB9AC\uC790 \uC804\uC6A9 \uC810\uAC80\uACFC \uBCF5\uAD6C \uC601\uC5ED',
    },
    {
      component: 'settings.backup',
      label: '\uC11C\uBC84 \uC790\uB3D9\uBC31\uC5C5 / \uBCF5\uC6D0',
      description: '\uC11C\uBC84 \uBC31\uC5C5\uACFC \uBCF5\uC6D0 \uC601\uC5ED',
    },
    {
      component: 'settings.footer',
      label: '\uD558\uB2E8 \uD45C\uC2DC',
      description: '\uC81C\uC791\uC790 \uD45C\uC2DC \uC601\uC5ED',
    },
  ],
};

export function createDefaultUiLayout(
  pageKey: UiPageKey = 'settings',
): UiLayout {
  return {
    schemaVersion: UI_LAYOUT_SCHEMA_VERSION,
    pageKey,
    sections: UI_COMPONENT_CATALOG[pageKey].map((item, order) => ({
      id: item.component,
      component: item.component,
      visible: true,
      order,
      width: 'full',
      height: 'auto',
      spacing: 'md',
      title: item.label,
    })),
  };
}

export function normalizeUiLayout(
  value: unknown,
  pageKey: UiPageKey = 'settings',
): UiLayout {
  const fallback = createDefaultUiLayout(pageKey);
  if (!value || typeof value !== 'object') return fallback;

  const source = value as { sections?: unknown[] };
  if (!Array.isArray(source.sections)) return fallback;

  const allowed = new Set(
    UI_COMPONENT_CATALOG[pageKey].map((item) => item.component),
  );
  const seen = new Set<string>();
  const sections: UiSection[] = [];

  source.sections.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Partial<UiSection>;
    const component = String(item.component ?? '').trim();
    if (!allowed.has(component) || seen.has(component)) return;
    seen.add(component);

    sections.push({
      id: String(item.id ?? component),
      component,
      visible: item.visible !== false,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      width: item.width === 'half' ? 'half' : 'full',
      height:
        item.height === 'compact' || item.height === 'tall'
          ? item.height
          : 'auto',
      spacing:
        item.spacing === 'none' ||
        item.spacing === 'sm' ||
        item.spacing === 'lg'
          ? item.spacing
          : 'md',
      title:
        typeof item.title === 'string'
          ? item.title.trim().slice(0, 80)
          : undefined,
    });
  });

  for (const definition of UI_COMPONENT_CATALOG[pageKey]) {
    if (!seen.has(definition.component)) {
      const section = createDefaultUiLayout(pageKey).sections.find(
        (item) => item.component === definition.component,
      );
      if (section) sections.push(section);
    }
  }

  sections.sort((a, b) => a.order - b.order);
  sections.forEach((section, order) => {
    section.order = order;
  });

  return {
    schemaVersion: UI_LAYOUT_SCHEMA_VERSION,
    pageKey,
    sections,
  };
}

export function moveUiSection(
  layout: UiLayout,
  sectionId: string,
  direction: -1 | 1,
): UiLayout {
  const sections = layout.sections.map((section) => ({ ...section }));
  const index = sections.findIndex((section) => section.id === sectionId);
  const target = index + direction;

  if (index < 0 || target < 0 || target >= sections.length) {
    return { ...layout, sections };
  }

  const [section] = sections.splice(index, 1);
  sections.splice(target, 0, section);
  sections.forEach((item, order) => {
    item.order = order;
  });

  return { ...layout, sections };
}
