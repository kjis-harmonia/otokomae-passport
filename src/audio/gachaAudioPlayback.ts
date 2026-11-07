// Coordinates audio permission with the current picture, without replaying the draw.
export type GachaAudioStatus = 'checking' | 'ready' | 'blocked'
export type GachaAudioPosition = { phase: 'idle' | 'intro' | 'tap' | 'open' | 'result'; offset: number; presented: boolean }
interface Sound {
  readonly state: AudioContextState
  unlock(): Promise<void>
  observeState(listener: () => void): () => void
  startIntro(at?: number, offset?: number): void
  startWait(at?: number, offset?: number): void
  open(at?: number, offset?: number): void
  result(): boolean
  stop(): void
  dispose(): void
}

export class GachaAudioPlayback {
  private sound: Sound
  private unobserve: () => void
  private disposed = false
  private generation = 0
  private checking = false
  private unlocked = false
  private played: 'intro' | 'tap' | 'open' | null = null
  private readonly createSound: () => Sound
  private readonly position: () => GachaAudioPosition
  private readonly report: (status: GachaAudioStatus) => void

  constructor(createSound: () => Sound, position: () => GachaAudioPosition, report: (status: GachaAudioStatus) => void) {
    this.createSound = createSound
    this.position = position
    this.report = report
    this.sound = createSound()
    this.unobserve = this.observe()
  }

  private observe(): () => void {
    return this.sound.observeState(() => {
      if (this.disposed || this.sound.state === 'running') return
      this.unlocked = false
      this.played = null
      this.sound.stop()
      this.report(this.checking ? 'checking' : 'blocked')
    })
  }

  // Called in the user's gesture. Late permission responses cannot revive a closed run.
  async unlock(): Promise<void> {
    if (this.disposed || this.checking) return
    this.checking = true
    const generation = ++this.generation
    this.report('checking')
    try {
      if (this.sound.state === 'closed') {
        this.unobserve()
        this.sound.dispose()
        this.sound = this.createSound()
        this.unobserve = this.observe()
        this.played = null
      }
      await this.sound.unlock()
      if (this.disposed || generation !== this.generation) return
      this.unlocked = true
      this.report('ready')
      this.sync()
    } catch {
      if (this.disposed || generation !== this.generation) return
      this.unlocked = false
      this.played = null
      this.sound.stop()
      this.report('blocked')
    } finally {
      if (generation === this.generation) this.checking = false
    }
  }

  // Read after resume, never captured before its asynchronous wait.
  sync(): void {
    if (this.disposed || !this.unlocked || this.sound.state !== 'running') return
    const { phase, offset, presented } = this.position()
    if (!presented) return
    if (phase === 'intro' && this.played !== 'intro') {
      this.sound.startIntro(undefined, offset)
      this.played = 'intro'
    } else if (phase === 'tap' && this.played !== 'tap') {
      // The intro already scheduled its waiting loop on the audio clock.
      if (this.played !== 'intro') this.sound.startWait(undefined, offset)
      this.played = 'tap'
    } else if (phase === 'open' && this.played !== 'open') {
      this.sound.open(undefined, offset)
      this.played = 'open'
    }
  }

  result(): boolean {
    return !this.disposed && this.unlocked && this.sound.result()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.generation
    this.unobserve()
    this.sound.dispose()
  }
}
