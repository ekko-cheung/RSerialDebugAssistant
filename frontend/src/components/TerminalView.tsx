import React, { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal as TerminalIcon, Trash2, ZoomIn, ZoomOut, Circle } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../i18n';
import { TerminalSendMode, TerminalLineEnding, TextEncoding, TerminalData } from '../types';

// shadcn components
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const STORAGE_KEY_SEND_MODE = 'serialDebug_terminalSendMode';
const STORAGE_KEY_LINE_ENDING = 'serialDebug_terminalLineEnding';
const STORAGE_KEY_LOCAL_ECHO = 'serialDebug_terminalLocalEcho';
const STORAGE_KEY_ENCODING = 'serialDebug_terminalEncoding';
const STORAGE_KEY_FONT_SIZE = 'serialDebug_terminalFontSize';

const POLL_INTERVAL_MS = 50;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 32;
const DEFAULT_FONT_SIZE = 14;

const lineEndingToStr = (ending: TerminalLineEnding): string => {
  switch (ending) {
    case 'CR': return '\r';
    case 'LF': return '\n';
    case 'CRLF': return '\r\n';
    default: return '';
  }
};

interface TerminalViewProps {
  isConnected: boolean;
}

const TerminalView: React.FC<TerminalViewProps> = ({ isConnected }) => {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);
  const cursorRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lineBufferRef = useRef('');
  const wasConnectedRef = useRef(isConnected);
  const lastPollErrorRef = useRef('');

  // Settings state (persisted) + refs for stable event handlers
  const [sendMode, setSendMode] = useState<TerminalSendMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_SEND_MODE);
    return saved === 'char' ? 'char' : 'line';
  });
  const [lineEnding, setLineEnding] = useState<TerminalLineEnding>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_LINE_ENDING);
    return saved === 'None' || saved === 'CR' || saved === 'LF' || saved === 'CRLF' ? saved : 'CRLF';
  });
  const [localEcho, setLocalEcho] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_LOCAL_ECHO);
    return saved === null ? true : saved === 'true';
  });
  const [encoding, setEncoding] = useState<TextEncoding>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_ENCODING);
    return saved === 'gbk' ? 'gbk' : 'utf-8';
  });
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem(STORAGE_KEY_FONT_SIZE) || '', 10);
    return !isNaN(saved) ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, saved)) : DEFAULT_FONT_SIZE;
  });

  const sendModeRef = useRef(sendMode);
  const lineEndingRef = useRef(lineEnding);
  const localEchoRef = useRef(localEcho);
  const encodingRef = useRef(encoding);
  const fontSizeRef = useRef(fontSize);
  const connectedRef = useRef(isConnected);

  useEffect(() => { sendModeRef.current = sendMode; }, [sendMode]);
  useEffect(() => { lineEndingRef.current = lineEnding; }, [lineEnding]);
  useEffect(() => { localEchoRef.current = localEcho; }, [localEcho]);
  useEffect(() => { encodingRef.current = encoding; }, [encoding]);
  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);
  useEffect(() => { connectedRef.current = isConnected; }, [isConnected]);

  // Persist settings
  useEffect(() => { localStorage.setItem(STORAGE_KEY_SEND_MODE, sendMode); }, [sendMode]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY_LINE_ENDING, lineEnding); }, [lineEnding]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY_LOCAL_ECHO, String(localEcho)); }, [localEcho]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY_ENCODING, encoding); }, [encoding]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY_FONT_SIZE, String(fontSize)); }, [fontSize]);

  // Send raw text through the shared serial connection (encoding applied in backend)
  const sendText = useCallback(async (text: string) => {
    if (!text || !connectedRef.current) return;
    try {
      await invoke('send_data', { data: text, format: 'Text', encoding: encodingRef.current });
    } catch (error) {
      console.error('Terminal send failed:', error);
    }
  }, []);

  // Handle typed / pasted input from xterm
  const handleData = useCallback((data: string) => {
    if (!connectedRef.current) return;

    if (sendModeRef.current === 'char') {
      // Character mode: send every key immediately, translate Enter per line ending
      let out = data;
      if (out.includes('\r')) {
        out = out.replace(/\r/g, lineEndingToStr(lineEndingRef.current));
      }
      sendText(out);
      if (localEchoRef.current) {
        termRef.current?.write(out);
      }
      return;
    }

    // Line mode: compose a local line, send on Enter
    const ending = lineEndingToStr(lineEndingRef.current);
    let echo = '';
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      const code = ch.charCodeAt(0);

      if (ch === '\x1b') {
        // Escape sequence (arrows, function keys): pass through immediately
        const rest = data.slice(i);
        sendText(rest);
        break;
      }
      if (ch === '\r') {
        // Enter: send the composed line (plus configured ending)
        sendText(lineBufferRef.current + ending);
        lineBufferRef.current = '';
        echo += '\r\n';
      } else if (ch === '\x7f' || ch === '\x08') {
        // Backspace: erase one char from the local line
        if (lineBufferRef.current.length > 0) {
          lineBufferRef.current = lineBufferRef.current.slice(0, -1);
          echo += '\b \b';
        }
      } else if (code < 0x20 && ch !== '\t') {
        // Other control characters (Ctrl+C etc.): send immediately, no echo
        sendText(ch);
      } else {
        lineBufferRef.current += ch;
        echo += ch;
      }
      i += 1;
    }
    if (echo) {
      termRef.current?.write(echo);
    }
  }, [sendText]);

  // Poll raw RX bytes from the backend ring buffer
  const pollTerminalData = useCallback(async () => {
    try {
      const result = await invoke<TerminalData>('get_terminal_data', { cursor: cursorRef.current });
      if (lastPollErrorRef.current) {
        // Error cleared — let a future error print again
        lastPollErrorRef.current = '';
      }
      if (result.bytes.length > 0) {
        const text = decoderRef.current?.decode(new Uint8Array(result.bytes)) ?? '';
        if (text) {
          termRef.current?.write(text);
        }
      }
      if (result.overflowed) {
        termRef.current?.writeln(`\r\n${t('terminal.dataLost')}\r\n`);
      }
      cursorRef.current = result.next_cursor;
    } catch (error) {
      console.error('Failed to poll terminal data:', error);
      // Show the failure inside the terminal so it is not silent (e.g. stale
      // backend that does not know the command yet). Throttled to one line
      // per distinct message.
      const message = error instanceof Error ? error.message : String(error);
      if (lastPollErrorRef.current !== message) {
        lastPollErrorRef.current = message;
        termRef.current?.writeln(`\r\n[terminal] get_terminal_data failed: ${message}\r\n`);
      }
    }
  }, [t]);

  // Terminal lifecycle
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      fontFamily: 'Menlo, Monaco, "DejaVu Sans Mono", "Courier New", monospace',
      scrollback: 2000,
      convertEol: false,
      theme: {
        background: colors.bgMain,
        foreground: colors.textPrimary,
        cursor: colors.accent,
        cursorAccent: colors.bgMain,
        selectionBackground: colors.accent,
        selectionInactiveBackground: colors.borderLight,
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // Ignore fit failures (e.g. container not laid out yet)
    }
    term.focus();
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const dataDisposable = term.onData(handleData);
    term.writeln(`=== ${t('terminal.title')} ===`);
    if (!connectedRef.current) {
      term.writeln(t('terminal.notConnected'));
    }

    return () => {
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recreate the decoder when encoding changes (keeps partial multibyte state)
  useEffect(() => {
    decoderRef.current = new TextDecoder(encoding, { fatal: false });
  }, [encoding]);

  // Poll while connected
  useEffect(() => {
    if (!isConnected) return;
    pollTimerRef.current = setInterval(pollTerminalData, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isConnected, pollTerminalData]);

  // Connection transitions: reset stream cursor and print status lines
  useEffect(() => {
    const wasConnected = wasConnectedRef.current;
    wasConnectedRef.current = isConnected;

    if (isConnected && !wasConnected) {
      cursorRef.current = 0; // backend buffer was reset on connect/disconnect
      termRef.current?.writeln(`\r\n=== ${t('terminal.connected')} ===\r\n`);
    } else if (!isConnected && wasConnected) {
      termRef.current?.writeln(`\r\n=== ${t('terminal.disconnected')} ===\r\n`);
    }
  }, [isConnected, t]);

  // Fit terminal when the container resizes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Ignore transient fit failures
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Apply font size changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
    }
  }, [fontSize]);

  // Apply theme changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = {
        background: colors.bgMain,
        foreground: colors.textPrimary,
        cursor: colors.accent,
        cursorAccent: colors.bgMain,
        selectionBackground: colors.accent,
        selectionInactiveBackground: colors.borderLight,
      };
    }
  }, [colors]);

  const handleClearScreen = () => {
    termRef.current?.clear();
  };

  const handleFontSizeChange = (delta: number) => {
    setFontSize(prev => Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, prev + delta)));
  };

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: colors.bgMain }}>
      {/* Toolbar */}
      <div
        className="h-9 px-4 flex items-center justify-between flex-shrink-0"
        style={{ backgroundColor: colors.bgHeader, borderBottom: `1px solid ${colors.borderDark}` }}
      >
        <div className="flex items-center gap-2" style={{ color: colors.textSecondary }}>
          <TerminalIcon size={16} style={{ color: colors.textTertiary }} />
          <span className="text-sm font-medium" style={{ color: colors.textPrimary }}>{t('terminal.title')}</span>
          <Circle
            size={8}
            fill={isConnected ? colors.success : colors.textTertiary}
            style={{ color: isConnected ? colors.success : colors.textTertiary }}
          />
        </div>

        <div className="flex items-center gap-3">
          {/* Send Mode */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs" style={{ color: colors.textTertiary }}>{t('terminal.sendMode')}:</span>
            <Select
              value={sendMode}
              onValueChange={(v) => setSendMode(v as TerminalSendMode)}
              disabled={!isConnected}
            >
              <SelectTrigger className="h-6 w-[88px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="line">{t('terminal.lineMode')}</SelectItem>
                <SelectItem value="char">{t('terminal.charMode')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Line Ending */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs" style={{ color: colors.textTertiary }}>{t('terminal.lineEnding')}:</span>
            <Select
              value={lineEnding}
              onValueChange={(v) => setLineEnding(v as TerminalLineEnding)}
              disabled={!isConnected}
            >
              <SelectTrigger className="h-6 w-[74px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="None">{t('terminal.none')}</SelectItem>
                <SelectItem value="CR">CR</SelectItem>
                <SelectItem value="LF">LF</SelectItem>
                <SelectItem value="CRLF">CRLF</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Encoding */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs" style={{ color: colors.textTertiary }}>{t('terminal.encoding')}:</span>
            <Select value={encoding} onValueChange={(v) => setEncoding(v as TextEncoding)}>
              <SelectTrigger className="h-6 w-[80px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="utf-8">UTF-8</SelectItem>
                <SelectItem value="gbk">GBK</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Local Echo (only meaningful in char mode) */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs" style={{ color: colors.textTertiary }}>{t('terminal.localEcho')}</span>
                  <Switch
                    checked={localEcho}
                    onCheckedChange={setLocalEcho}
                    disabled={sendMode === 'line'}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('terminal.localEchoHint')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Font size */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleFontSizeChange(-1)}
              disabled={fontSize <= MIN_FONT_SIZE}
            >
              <ZoomOut size={14} />
            </Button>
            <span className="text-xs w-8 text-center" style={{ color: colors.textTertiary }}>{fontSize}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleFontSizeChange(1)}
              disabled={fontSize >= MAX_FONT_SIZE}
            >
              <ZoomIn size={14} />
            </Button>
          </div>

          {/* Clear screen */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleClearScreen}>
                  <Trash2 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('terminal.clearScreen')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Terminal body */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden p-1">
        {/* xterm mounts here */}
      </div>
    </div>
  );
};

export default TerminalView;
