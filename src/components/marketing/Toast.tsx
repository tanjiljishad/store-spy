export interface ToastProps {
  message: string | null;
}

export function Toast({ message }: ToastProps) {
  return (
    <div
      className={`fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-lg border border-line bg-surface-2 px-5 py-3 font-mono text-[12.5px] text-paper shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] transition-all duration-300 ${
        message ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-5 opacity-0"
      }`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
