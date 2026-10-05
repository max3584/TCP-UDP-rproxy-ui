// タブの並び（WAI-ARIA の Tabs。矢印キー / Home / End で移る）。パネルは呼び出し側が
// role="tabpanel"・id={`${id}-panel-${タブ}`}・aria-labelledby={`${id}-tab-${タブ}`} で置く（tabPanelProps）
import React from 'react';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  // ラベルの後ろに出す小さな印（ずれ・警告など）
  badge?: React.ReactNode;
}

export function tabPanelProps(id: string, tab: string) {
  return {
    role: 'tabpanel',
    id: `${id}-panel-${tab}`,
    'aria-labelledby': `${id}-tab-${tab}`,
    tabIndex: 0,
    className: 'space-y-4 focus:outline-hidden',
  };
}

const Tabs: React.FC<{ id: string; label: string; tabs: TabItem[]; active: string; onChange: (tab: string) => void }> = ({ id, label, tabs, active, onChange }) => {
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.findIndex((t) => t.id === active);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(tabs[next].id);
    document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex overflow-x-auto lg:flex-wrap shadow-[inset_0_-1px_0_#d1d5db]">
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${id}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${id}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={onKeyDown}
            className={`shrink-0 whitespace-nowrap px-3 py-2 max-lg:min-h-11 text-sm border-b-2 focus:outline-hidden focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-blue-500 ${selected
              ? 'border-blue-600 text-blue-700 font-semibold bg-white'
              : 'border-transparent text-gray-700 hover:text-gray-900 bg-transparent'}`}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
};

export default Tabs;
