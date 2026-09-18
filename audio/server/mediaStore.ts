import { DeskThing } from "@deskthing/server";
import { SongAbilities, SongData11 } from "@deskthing/types";
import { NowPlaying } from "./nowplayingWrapper";
import type {
  NowPlayingMessage,
  NowPlaying as NowPlayingType,
} from "node-nowplaying";
import { saveImage } from "./imageUtils";
import crypto from "node:crypto";
import loudness from "loudness";
import { JriverBridge, type JriverStatus } from "./jriverBridge";
import { MediaMonkeyBridge, type MediaMonkeyStatus } from "./mediaMonkeyBridge";
import { WmpBridge, type WmpStatus } from "./wmpBridge";

function getAudioHash(songId: string): string {
  return crypto.createHash("sha256").update(songId).digest("hex").slice(0, 16);
}
function cleanMetadata(value: string | undefined): string {
  const text = value?.replace(/\s+/g, " ").trim() || "";
  return /^(nothing|none|unknown)$/i.test(text) ? "" : text;
}

export class MediaStore {
  private static instance: MediaStore;
  private player: NowPlayingType;
  private nowPlayingInfo: NowPlayingMessage | undefined;
  private windowsNowPlayingInfo: NowPlayingMessage | undefined;
  private lastSong: SongData11 | undefined;
  private isSubscribed = false;

  private jriver = new JriverBridge();
  private jriverTimer: NodeJS.Timeout | null = null;
  private jriverBusy = false;
  private jriverOwnsPlayback = false;
  private jriverMisses = 0;
  private lastJriverSongId = "";
  private lastJriverPlaying = false;
  private lastJriverSendAt = 0;

  private mediaMonkey = new MediaMonkeyBridge();
  private mediaMonkeyTimer: NodeJS.Timeout | null = null;
  private mediaMonkeyBusy = false;
  private mediaMonkeyOwnsPlayback = false;
  private mediaMonkeyMisses = 0;
  private lastMediaMonkeySongId = "";
  private lastMediaMonkeyPlaying = false;
  private lastMediaMonkeySendAt = 0;

  private wmp = new WmpBridge();
  private wmpTimer: NodeJS.Timeout | null = null;
  private wmpBusy = false;
  private wmpOwnsPlayback = false;
  private wmpMisses = 0;
  private lastWmpSongId = "";
  private lastWmpPlaying = false;
  private lastWmpSendAt = 0;

  private volumeTimeout: NodeJS.Timeout | null = null;

  private constructor() {
    this.player = new NowPlaying(this.handleMessage.bind(this));
  }

  public initializeListeners = async (): Promise<void> => {
    if (!this.isSubscribed) {
      await this.player.subscribe();
      this.isSubscribed = true;
    }
    this.startJriverPolling();
    this.startMediaMonkeyPolling();
    this.startWmpPolling();
  };

  private async handleMessage(message: NowPlayingMessage): Promise<void> {
    this.windowsNowPlayingInfo = { ...message };
    if (
      this.jriverOwnsPlayback ||
      this.mediaMonkeyOwnsPlayback ||
      this.wmpOwnsPlayback
    )
      return;
    await this.activateWindowsMessage(this.windowsNowPlayingInfo);
  }

  private async activateWindowsMessage(
    message: NowPlayingMessage,
  ): Promise<void> {
    const nextMessage = { ...message };
    if (nextMessage.thumbnail) {
      const safeName = getAudioHash(
        nextMessage.id || `${nextMessage.trackName}-${nextMessage.artist}`,
      );
      nextMessage.thumbnail = await saveImage(nextMessage.thumbnail, safeName);
    }

    this.nowPlayingInfo = nextMessage;
    await this.parseAndSendData();
  }

  private startJriverPolling(): void {
    if (process.platform !== "win32" || this.jriverTimer) return;
    this.jriver.initialize();
    this.jriverTimer = setInterval(() => void this.refreshJriver(), 100);
    void this.refreshJriver();
  }

  private stopJriverPolling(): void {
    if (this.jriverTimer) clearInterval(this.jriverTimer);
    this.jriverTimer = null;
    this.jriver.stop();
  }

  private async refreshJriver(): Promise<void> {
    if (this.jriverBusy) return;
    this.jriverBusy = true;

    try {
      const status = await this.jriver.getStatus();
      if (!status) {
        this.jriverMisses += 1;
        if (this.jriverOwnsPlayback && this.jriverMisses >= 5) {
          await this.releaseJriver();
        }
        return;
      }

      this.jriverMisses = 0;
      if (status.isPlaying || (status.isPaused && this.jriverOwnsPlayback)) {
        await this.activateJriver(status);
      } else if (this.jriverOwnsPlayback) {
        await this.releaseJriver();
      }
    } finally {
      this.jriverBusy = false;
    }
  }

  private async activateJriver(status: JriverStatus): Promise<void> {
    const title = cleanMetadata(status.title);
    if (!title) return;

    this.jriverOwnsPlayback = true;
    const songId = `jriver:${status.fileId}`;
    const now = Date.now();
    this.nowPlayingInfo = {
      id: songId,
      trackName: title,
      artist: cleanMetadata(status.artist)
        ? [cleanMetadata(status.artist)]
        : undefined,
      album: cleanMetadata(status.album) || undefined,
      isPlaying: status.isPlaying,
      trackDuration: status.durationMs || undefined,
      trackProgress:
        status.durationMs > 0
          ? Math.min(status.positionMs, status.durationMs)
          : undefined,
      canFastForward: false,
      canSkip: true,
      canLike: false,
      canChangeVolume: true,
      canSetOutput: false,
      volume: await loudness.getVolume(),
      device: "JRiver Media Center",
      deviceId: "jriver:active-zone",
    };

    const shouldSend =
      songId !== this.lastJriverSongId ||
      status.isPlaying !== this.lastJriverPlaying ||
      now - this.lastJriverSendAt >= 500;

    if (shouldSend) {
      this.lastJriverSongId = songId;
      this.lastJriverPlaying = status.isPlaying;
      this.lastJriverSendAt = now;
      await this.parseAndSendData();
    }
  }

  private async releaseJriver(): Promise<void> {
    this.jriverOwnsPlayback = false;
    this.lastJriverSongId = "";
    await this.refreshMediaMonkey();
    await this.refreshWmp();
    if (
      !this.mediaMonkeyOwnsPlayback &&
      !this.wmpOwnsPlayback &&
      this.windowsNowPlayingInfo
    ) {
      await this.activateWindowsMessage(this.windowsNowPlayingInfo);
    }
  }

  private startMediaMonkeyPolling(): void {
    if (process.platform !== "win32" || this.mediaMonkeyTimer) return;
    this.mediaMonkey.initialize();
    this.mediaMonkeyTimer = setInterval(
      () => void this.refreshMediaMonkey(),
      100,
    );
    void this.refreshMediaMonkey();
  }

  private stopMediaMonkeyPolling(): void {
    if (this.mediaMonkeyTimer) clearInterval(this.mediaMonkeyTimer);
    this.mediaMonkeyTimer = null;
    this.mediaMonkey.stop();
  }

  private async refreshMediaMonkey(): Promise<void> {
    if (this.jriverOwnsPlayback || this.mediaMonkeyBusy) return;
    this.mediaMonkeyBusy = true;

    try {
      const status = await this.mediaMonkey.getStatus();
      if (!status) {
        this.mediaMonkeyMisses += 1;
        if (this.mediaMonkeyOwnsPlayback && this.mediaMonkeyMisses >= 5) {
          await this.releaseMediaMonkey();
        }
        return;
      }

      this.mediaMonkeyMisses = 0;
      if (
        status.isPlaying ||
        (status.isPaused && this.mediaMonkeyOwnsPlayback)
      ) {
        await this.activateMediaMonkey(status);
      } else if (this.mediaMonkeyOwnsPlayback) {
        await this.releaseMediaMonkey();
      }
    } finally {
      this.mediaMonkeyBusy = false;
    }
  }

  private async activateMediaMonkey(status: MediaMonkeyStatus): Promise<void> {
    const title = cleanMetadata(status.title);
    if (!title) return;

    this.mediaMonkeyOwnsPlayback = true;
    const songId = `mediamonkey:${getAudioHash(status.id)}`;
    const now = Date.now();
    this.nowPlayingInfo = {
      id: songId,
      trackName: title,
      artist: cleanMetadata(status.artist)
        ? [cleanMetadata(status.artist)]
        : undefined,
      album: cleanMetadata(status.album) || undefined,
      isPlaying: status.isPlaying,
      trackDuration: status.durationMs || undefined,
      trackProgress:
        status.durationMs > 0
          ? Math.min(status.positionMs, status.durationMs)
          : status.positionMs,
      canFastForward: true,
      canSkip: true,
      canLike: false,
      canChangeVolume: true,
      canSetOutput: false,
      volume: await loudness.getVolume(),
      device: "MediaMonkey",
      deviceId: "mediamonkey:local",
    };

    const shouldSend =
      songId !== this.lastMediaMonkeySongId ||
      status.isPlaying !== this.lastMediaMonkeyPlaying ||
      now - this.lastMediaMonkeySendAt >= 250;

    if (shouldSend) {
      this.lastMediaMonkeySongId = songId;
      this.lastMediaMonkeyPlaying = status.isPlaying;
      this.lastMediaMonkeySendAt = now;
      await this.parseAndSendData();
    }
  }

  private async releaseMediaMonkey(): Promise<void> {
    this.mediaMonkeyOwnsPlayback = false;
    this.lastMediaMonkeySongId = "";
    await this.refreshWmp();
    if (
      !this.jriverOwnsPlayback &&
      !this.wmpOwnsPlayback &&
      this.windowsNowPlayingInfo
    ) {
      await this.activateWindowsMessage(this.windowsNowPlayingInfo);
    }
  }

  private startWmpPolling(): void {
    if (process.platform !== "win32" || this.wmpTimer) return;
    this.wmp.initialize();
    this.wmpTimer = setInterval(() => void this.refreshWmp(), 100);
    void this.refreshWmp();
  }

  private stopWmpPolling(): void {
    if (this.wmpTimer) clearInterval(this.wmpTimer);
    this.wmpTimer = null;
    this.wmp.stop();
  }

  private async refreshWmp(): Promise<void> {
    if (
      this.jriverOwnsPlayback ||
      this.mediaMonkeyOwnsPlayback ||
      this.wmpBusy
    )
      return;
    this.wmpBusy = true;

    try {
      const status = await this.wmp.getStatus();
      if (!status) {
        this.wmpMisses += 1;
        if (this.wmpOwnsPlayback && this.wmpMisses >= 5) {
          await this.releaseWmp();
        }
        return;
      }

      this.wmpMisses = 0;
      if (status.isPlaying || (status.isPaused && this.wmpOwnsPlayback)) {
        await this.activateWmp(status);
      } else if (this.wmpOwnsPlayback) {
        await this.releaseWmp();
      }
    } finally {
      this.wmpBusy = false;
    }
  }

  private async activateWmp(status: WmpStatus): Promise<void> {
    const title = cleanMetadata(status.title);
    if (!title) return;

    this.wmpOwnsPlayback = true;
    const songId = `wmp:${getAudioHash(status.id)}`;
    const now = Date.now();
    this.nowPlayingInfo = {
      id: songId,
      trackName: title,
      artist: cleanMetadata(status.artist)
        ? [cleanMetadata(status.artist)]
        : undefined,
      album: cleanMetadata(status.album) || undefined,
      isPlaying: status.isPlaying,
      trackDuration: status.durationMs || undefined,
      trackProgress:
        status.durationMs > 0
          ? Math.min(status.positionMs, status.durationMs)
          : status.positionMs,
      canFastForward: true,
      canSkip: true,
      canLike: false,
      canChangeVolume: true,
      canSetOutput: false,
      volume: await loudness.getVolume(),
      device: "Windows Media Player",
      deviceId: "wmp:local",
    };

    const shouldSend =
      songId !== this.lastWmpSongId ||
      status.isPlaying !== this.lastWmpPlaying ||
      now - this.lastWmpSendAt >= 250;

    if (shouldSend) {
      this.lastWmpSongId = songId;
      this.lastWmpPlaying = status.isPlaying;
      this.lastWmpSendAt = now;
      await this.parseAndSendData();
    }
  }

  private async releaseWmp(): Promise<void> {
    this.wmpOwnsPlayback = false;
    this.lastWmpSongId = "";
    if (
      !this.jriverOwnsPlayback &&
      !this.mediaMonkeyOwnsPlayback &&
      this.windowsNowPlayingInfo
    ) {
      await this.activateWindowsMessage(this.windowsNowPlayingInfo);
    }
  }

  public purge = (): void => {
    this.player.unsubscribe();
    this.isSubscribed = false;
    this.nowPlayingInfo = undefined;
    this.windowsNowPlayingInfo = undefined;
    this.lastSong = undefined;
    this.stopJriverPolling();
    this.stopMediaMonkeyPolling();
    this.stopWmpPolling();
  };

  public stop = (): void => {
    this.player.unsubscribe();
    this.isSubscribed = false;
    this.stopJriverPolling();
    this.stopMediaMonkeyPolling();
    this.stopWmpPolling();
  };

  public start = async (): Promise<void> => {
    if (!this.isSubscribed) {
      await this.player.subscribe();
      this.isSubscribed = true;
    }
    this.startJriverPolling();
    this.startMediaMonkeyPolling();
    this.startWmpPolling();
  };

  private getAbilities(data: NowPlayingMessage): SongAbilities[] {
    const abilities: SongAbilities[] = [];
    if (data.canFastForward) abilities.push(SongAbilities.FAST_FORWARD);
    if (data.canLike) abilities.push(SongAbilities.LIKE);
    if (data.canSkip) abilities.push(SongAbilities.NEXT);
    if (data.canChangeVolume) abilities.push(SongAbilities.CHANGE_VOLUME);
    if (data.canSetOutput) abilities.push(SongAbilities.SET_OUTPUT);
    return abilities;
  }

  private nanoToMilli(nano: number): number {
    return nano / 10000;
  }

  private async parseAndSendData(): Promise<void> {
    if (!this.nowPlayingInfo) return;

    const isNano =
      this.nowPlayingInfo.trackDuration &&
      this.nowPlayingInfo.trackDuration > 18000000;
    const currentVol = await loudness.getVolume();
    const musicPayload: SongData11 = {
      version: 2,
      source: "local",
      track_name: cleanMetadata(this.nowPlayingInfo.trackName),
      album: cleanMetadata(this.nowPlayingInfo.album) || null,
      artist: cleanMetadata(this.nowPlayingInfo.artist?.[0]) || null,
      playlist: this.nowPlayingInfo.playlist || null,
      playlist_id: this.nowPlayingInfo.playlistId || null,
      shuffle_state: this.nowPlayingInfo.shuffleState ?? null,
      repeat_state:
        (this.nowPlayingInfo.repeatState as "off" | "all" | "track") || "off",
      is_playing: this.nowPlayingInfo.isPlaying,
      abilities: this.getAbilities(this.nowPlayingInfo),
      track_duration:
        this.nowPlayingInfo.trackDuration && isNano
          ? this.nanoToMilli(this.nowPlayingInfo.trackDuration)
          : (this.nowPlayingInfo.trackDuration ?? null),
      track_progress:
        this.nowPlayingInfo.trackProgress && isNano
          ? this.nanoToMilli(this.nowPlayingInfo.trackProgress)
          : (this.nowPlayingInfo.trackProgress ?? null),
      volume: currentVol,
      thumbnail: this.nowPlayingInfo.thumbnail || null,
      device: this.nowPlayingInfo.device || null,
      device_id: this.nowPlayingInfo.deviceId || null,
      id: this.nowPlayingInfo.id || null,
      can_like: this.nowPlayingInfo.canLike ?? undefined,
      can_change_volume: this.nowPlayingInfo.canChangeVolume ?? undefined,
      can_set_output: this.nowPlayingInfo.canSetOutput ?? undefined,
      can_fast_forward: this.nowPlayingInfo.canFastForward ?? undefined,
      can_skip: this.nowPlayingInfo.canSkip ?? undefined,
    };

    this.lastSong = musicPayload;
    DeskThing.sendSong(musicPayload);
  }

  public static getInstance(): MediaStore {
    if (!MediaStore.instance) MediaStore.instance = new MediaStore();
    return MediaStore.instance;
  }

  public async handleGetSong(): Promise<void> {
    await this.refreshJriver();
    await this.refreshMediaMonkey();
    await this.refreshWmp();
    await this.parseAndSendData();
  }

  public async handleRefresh(): Promise<void> {
    await this.refreshJriver();
    await this.refreshMediaMonkey();
    await this.refreshWmp();
    await this.parseAndSendData();
  }

  public handleFastForward(data: { amount: number | undefined }): void {
    if (this.mediaMonkeyOwnsPlayback) {
      void this.sendMediaMonkeyCommand("seek", data.amount || 0);
    } else if (this.wmpOwnsPlayback) {
      void this.sendWmpCommand("seek", data.amount || 0);
    } else if (!this.jriverOwnsPlayback) {
      this.player.seekTo(data.amount || 0);
    }
  }

  public handleLike(): void {
    console.warn("Liking songs is not supported!");
  }

  public handleNext(): void {
    if (this.jriverOwnsPlayback) void this.sendJriverCommand("next");
    else if (this.mediaMonkeyOwnsPlayback)
      void this.sendMediaMonkeyCommand("next");
    else if (this.wmpOwnsPlayback) void this.sendWmpCommand("next");
    else this.player.nextTrack();
  }

  public handlePause(): void {
    if (this.jriverOwnsPlayback) void this.sendJriverCommand("pause");
    else if (this.mediaMonkeyOwnsPlayback)
      void this.sendMediaMonkeyCommand("pause");
    else if (this.wmpOwnsPlayback) void this.sendWmpCommand("pause");
    else this.player.pause();
  }

  public handlePlay(): void {
    if (this.jriverOwnsPlayback) void this.sendJriverCommand("play");
    else if (this.mediaMonkeyOwnsPlayback)
      void this.sendMediaMonkeyCommand("play");
    else if (this.wmpOwnsPlayback) void this.sendWmpCommand("play");
    else this.player.play();
  }

  public handlePrevious(): void {
    if (this.jriverOwnsPlayback) void this.sendJriverCommand("previous");
    else if (this.mediaMonkeyOwnsPlayback)
      void this.sendMediaMonkeyCommand("previous");
    else if (this.wmpOwnsPlayback) void this.sendWmpCommand("previous");
    else this.player.previousTrack();
  }

  public handleRepeat(): void {
    console.warn("Repeating songs is not supported!");
  }

  public handleRewind(data: { amount: number | undefined }): void {
    if (this.mediaMonkeyOwnsPlayback) {
      void this.sendMediaMonkeyCommand("seek", data.amount || 0);
    } else if (this.wmpOwnsPlayback) {
      void this.sendWmpCommand("seek", data.amount || 0);
    } else if (!this.jriverOwnsPlayback) {
      this.player.seekTo(data.amount || 0);
    }
  }

  public handleSeek(data: { positionMs: number }): void {
    if (this.mediaMonkeyOwnsPlayback) {
      void this.sendMediaMonkeyCommand("seek", data.positionMs);
    } else if (this.wmpOwnsPlayback) {
      void this.sendWmpCommand("seek", data.positionMs);
    } else if (!this.jriverOwnsPlayback) {
      this.player.seekTo(data.positionMs);
    }
  }

  public handleShuffle(data: { shuffle: boolean }): void {
    if (
      !this.jriverOwnsPlayback &&
      !this.mediaMonkeyOwnsPlayback &&
      !this.wmpOwnsPlayback
    )
      this.player.setShuffle(data.shuffle);
  }

  public handleStop(): void {
    if (this.jriverOwnsPlayback) void this.sendJriverCommand("stop");
    else if (this.mediaMonkeyOwnsPlayback)
      void this.sendMediaMonkeyCommand("stop");
    else if (this.wmpOwnsPlayback) void this.sendWmpCommand("stop");
    else this.player.pause();
  }

  private async sendJriverCommand(
    command: "play" | "pause" | "stop" | "next" | "previous",
  ): Promise<void> {
    await this.jriver.command(command);
    setTimeout(() => void this.refreshJriver(), 25);
  }

  private async sendMediaMonkeyCommand(
    command: "play" | "pause" | "stop" | "next" | "previous" | "seek",
    positionMs?: number,
  ): Promise<void> {
    await this.mediaMonkey.command(command, positionMs);
    setTimeout(() => void this.refreshMediaMonkey(), 25);
  }

  private async sendWmpCommand(
    command: "play" | "pause" | "stop" | "next" | "previous" | "seek",
    positionMs?: number,
  ): Promise<void> {
    await this.wmp.command(command, positionMs);
    setTimeout(() => void this.refreshWmp(), 25);
  }

  private async setVolume(volume: number): Promise<void> {
    try {
      await loudness.setVolume(volume);
      if (!this.lastSong) return;

      this.lastSong.volume = volume;
      DeskThing.sendSong(this.lastSong);
    } catch (error) {
      console.error(
        `Failed to set volume to ${volume}! It may be due to an unsupported OS: `,
        error,
      );
    }
  }

  public async handleVolume(data: { volume: number }): Promise<void> {
    if (!Number.isFinite(data.volume)) {
      console.error("Volume is required");
      return;
    }

    if (data.volume < 0 || data.volume > 100) {
      data.volume =
        Math.abs(data.volume) < Math.abs(data.volume - 100) ? 0 : 100;
    }

    if (this.volumeTimeout) {
      clearTimeout(this.volumeTimeout);
      this.volumeTimeout = setTimeout(async () => {
        this.volumeTimeout = null;
        await this.setVolume(data.volume);
      }, 1000);
    } else {
      this.volumeTimeout = setTimeout(() => {
        this.volumeTimeout = null;
      }, 1000);
      await this.setVolume(data.volume);
    }
  }
}
