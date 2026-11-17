import activate from './index.mjs';

// Cordis owns the scope; the network transport remains independently testable.
export function apply(ctx, config = {}) {
  let disposed = false;
  const cleanups = new Set();
  const stop = () => { disposed = true; for (const close of [...cleanups]) close(); };
  ctx.effect?.(() => stop, 'ai-maid-cafe.dsh-bridge');
  const start = host => {
    if (disposed) return;
    let closed = false; let dispose;
    const close = () => { if (closed) return; closed = true; dispose?.(); cleanups.delete(close); };
    cleanups.add(close);
    host.effect?.(() => close, 'ai-maid-cafe.dsh-transport');
    return activate(host, config).then(value => {
      if (closed || disposed) value(); else dispose = value;
    }).catch(error => {
      close();
      (host.logger ?? console).warn('AI Maid Cafe DSH bridge could not start: ' + String(error.message));
    });
  };
  if (typeof ctx.inject === 'function') {
    return ctx.inject(['sessionController'], child => { void start(child ?? ctx); });
  }
  return start(ctx);
}

export default { name: 'ai-maid-cafe-dsh-bridge', apply };
