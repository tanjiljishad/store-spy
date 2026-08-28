export function SiteFooter() {
  return (
    <footer className="border-t border-line-soft py-7">
      <div className="mx-auto flex max-w-[1180px] flex-wrap justify-between gap-4 px-7 font-mono text-[11.5px] text-muted-dim">
        <span>© 2026 Bellwether Intelligence</span>
        <span className="flex gap-2">
          <a className="transition hover:text-paper" href="#">
            Privacy
          </a>{" "}
          ·{" "}
          <a className="transition hover:text-paper" href="#">
            Terms
          </a>{" "}
          ·{" "}
          <a className="transition hover:text-paper" href="#">
            How we collect data
          </a>{" "}
          ·{" "}
          <a className="transition hover:text-paper" href="#">
            Support
          </a>
        </span>
      </div>
    </footer>
  );
}
