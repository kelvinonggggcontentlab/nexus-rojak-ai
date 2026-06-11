import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BLACKTOWER NEXUS V2 — AI Personal Assistant" },
      {
        name: "description",
        content:
          "BLACKTOWER NEXUS V2 is an AI-powered personal assistant delivered through Telegram — intelligent conversations, task management, and 24/7 support.",
      },
      { property: "og:title", content: "BLACKTOWER NEXUS V2 — AI Personal Assistant" },
      {
        property: "og:description",
        content:
          "An AI-powered personal assistant delivered through Telegram — intelligent conversations, task management, and 24/7 support.",
      },
      { property: "og:url", content: "https://nexus-rojak-ai.lovable.app/" },
      { property: "og:type", content: "website" },
    ],
    links: [{ rel: "canonical", href: "https://nexus-rojak-ai.lovable.app/" }],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-24">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          BLACKTOWER NEXUS V2 — Your AI Personal Assistant on Telegram
        </h1>
        <p className="text-lg text-muted-foreground">
          Nexus is a private, always-on AI assistant that lives inside Telegram. Chat
          with it like a friend, ask it to remember things, plan your day, or work
          through ideas — no new app to install, no context to re-explain.
        </p>
        <p className="text-base text-muted-foreground">
          Powered by modern large language models, Nexus handles natural conversation,
          long-running memory, and task tracking. It learns the way you write, stays
          available 24/7, and replies in seconds wherever you have Telegram open — on
          your phone, laptop, or desktop.
        </p>
        <p className="text-base text-muted-foreground">
          Built for a single operator, Nexus is locked to an allowlisted Telegram
          account so your conversations stay yours. Use it as a thinking partner, a
          second brain, or a tireless executive assistant.
        </p>
      </section>
    </main>
  );
}
