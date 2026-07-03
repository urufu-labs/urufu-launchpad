'use client';

import { motion } from 'framer-motion';
import { useDraggable } from '@dnd-kit/core';

import type { ModuleSpec } from '@/lib/modules';

interface Props {
  mod: ModuleSpec;
  onQuickAdd?: () => void;
}

const CATEGORY_STYLE: Record<ModuleSpec['category'], { polaroid: string; stamp: string; emoji: string }> = {
  token: { polaroid: 'kawaii-polaroid-mint', stamp: 'kawaii-stamp-mint', emoji: '🪙' },
  nft: { polaroid: 'kawaii-polaroid-cyan', stamp: 'kawaii-stamp-cyan', emoji: '🎨' },
  allocation: { polaroid: 'kawaii-polaroid-yolk', stamp: 'kawaii-stamp-yolk', emoji: '📦' },
  governance: { polaroid: '', stamp: 'kawaii-stamp-cream', emoji: '🏛️' },
  hook: { polaroid: '', stamp: '', emoji: '🪝' },
};

export function ShelfItem({ mod, onQuickAdd }: Props) {
  const style = CATEGORY_STYLE[mod.category];
  const disabled = mod.status === 'planned';

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `shelf-${mod.id}`,
    data: { moduleId: mod.id, source: 'shelf' },
    disabled,
  });

  return (
    <motion.div
      ref={setNodeRef}
      whileHover={disabled ? undefined : { scale: 1.02, rotate: -1 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      {...listeners}
      {...attributes}
      data-dragging={isDragging}
      className={`kawaii-polaroid ${style.polaroid} relative p-4 select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
      }`}
    >
      <span className={`kawaii-tape ${style.polaroid.includes('mint') ? 'kawaii-tape-mint' : ''}`}
        style={{ top: -6, left: 16, transform: 'rotate(-6deg)' }}
      />

      <div className="flex items-start gap-3">
        <div className="text-2xl leading-none flex-shrink-0" aria-hidden>{style.emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm">{mod.label}</span>
            {disabled ? (
              <span className={`kawaii-stamp ${style.stamp}`}>planned</span>
            ) : (
              <span className={`kawaii-stamp ${style.stamp}`}>v{mod.version}</span>
            )}
            {mod.flagged && <span className="kawaii-stamp" style={{ background: '#ff8585' }}>flagged</span>}
          </div>
          <p className="mt-2 text-xs leading-snug text-[var(--zone-ink-soft)]">
            {mod.description}
          </p>
          <div className="mt-2 flex items-center gap-2 text-[10px] font-mono text-[var(--zone-ink-soft)] uppercase tracking-widest">
            <span>{mod.bases.join(' · ')}</span>
            <span>·</span>
            <span>{mod.abiEncode}</span>
          </div>
        </div>
      </div>

      {!disabled && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onQuickAdd?.();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="mt-3 w-full rounded-full border-2 border-[var(--zone-ink)] bg-white py-1 text-[11px] font-bold uppercase tracking-widest text-[var(--zone-ink)] hover:bg-[var(--rose-300)] transition-colors"
        >
          + add to cart
        </button>
      )}
    </motion.div>
  );
}
