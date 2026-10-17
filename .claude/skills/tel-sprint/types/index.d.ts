export type Card = { id: number; title: string; status: string; url: string }
export type Sprint = { cards: Card[]; error?: string; updatedAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'tel-sprint': { sprint: Sprint }
  }
}
