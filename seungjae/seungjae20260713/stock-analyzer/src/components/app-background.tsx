import { useSettings } from '@/lib/settings';

// Theme-aware backdrop. In dark mode it renders a subtle top-lit gradient over
// a near-black base; in light mode it renders a soft light gradient so the
// translucent cards keep their contrast. The backdrop must follow the active
// theme, otherwise a hardcoded dark base would show through the translucent
// app shell and make light mode look dark.
export function AppBackground() {
  const { settings } = useSettings();

  if (settings.theme === 'light') {
    return (
      <div className="fixed inset-0 z-0 bg-[#eef1f6]">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 80% at 50% -10%, rgba(37,99,235,0.10) 0%, rgba(238,241,246,0) 45%), linear-gradient(180deg, #f3f5f9 0%, #eef1f6 55%, #e8ebf1 100%)',
          }}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-0 bg-[#04070c]">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 80% at 50% -10%, rgba(37,99,235,0.14) 0%, rgba(4,7,12,0) 45%), linear-gradient(180deg, #070b12 0%, #05080d 55%, #04060a 100%)',
        }}
      />
    </div>
  );
}
