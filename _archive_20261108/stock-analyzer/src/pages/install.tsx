import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  MonitorSmartphone,
  Share2,
  Smartphone,
} from 'lucide-react';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const APP_NAME = '지식정보';
const APP_VERSION = '1.0.0';

function isStandaloneMode() {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || iosNavigator.standalone === true;
}

export default function InstallPage() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState('설치 가능 여부를 확인하고 있습니다.');
  const [copied, setCopied] = useState(false);

  const platform = useMemo(() => {
    const userAgent = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(userAgent)) return 'ios';
    if (/android/.test(userAgent)) return 'android';
    return 'desktop';
  }, []);

  useEffect(() => {
    document.title = `${APP_NAME} 설치`;
    const standalone = isStandaloneMode();
    setInstalled(standalone);
    if (standalone) setMessage(`${APP_NAME} 앱이 이미 설치되어 있습니다.`);
    else if (platform === 'ios') setMessage('Safari 공유 메뉴에서 홈 화면에 추가를 선택하세요.');
    else setMessage('설치 버튼이 나타나면 바로 앱으로 설치할 수 있습니다.');

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
      setMessage('설치 준비가 완료되었습니다. 아래 설치 버튼을 누르세요.');
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
      setMessage(`${APP_NAME} 설치가 완료되었습니다.`);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [platform]);

  async function install() {
    if (installed) {
      setMessage(`${APP_NAME} 앱이 이미 설치되어 있습니다.`);
      return;
    }
    if (!promptEvent) {
      setMessage(
        platform === 'ios'
          ? 'Safari 아래쪽 공유 버튼을 누른 뒤 홈 화면에 추가를 선택하세요.'
          : platform === 'android'
            ? 'Chrome 오른쪽 위 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택하세요.'
            : '브라우저 주소창 오른쪽의 설치 아이콘 또는 메뉴의 앱 설치를 선택하세요.',
      );
      return;
    }

    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    setMessage(choice.outcome === 'accepted' ? '설치를 시작했습니다.' : '설치를 취소했습니다.');
    setPromptEvent(null);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setMessage('설치 링크를 복사했습니다. 지인에게 그대로 보내면 됩니다.');
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setMessage('주소창의 설치 링크를 길게 눌러 복사해 주세요.');
    }
  }

  async function shareLink() {
    if (!navigator.share) {
      await copyLink();
      return;
    }
    try {
      await navigator.share({
        title: `${APP_NAME} 설치`,
        text: `${APP_NAME} 앱 설치 링크`,
        url: window.location.href,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setMessage('공유하지 못했습니다. 설치 링크 복사를 이용해 주세요.');
    }
  }

  const guide = platform === 'ios'
    ? [
        'Safari에서 이 설치 페이지를 엽니다.',
        '화면 아래쪽 공유 버튼을 누릅니다.',
        '홈 화면에 추가를 선택한 뒤 추가를 누릅니다.',
      ]
    : platform === 'android'
      ? [
          'Android Chrome에서 이 설치 페이지를 엽니다.',
          '지식정보 설치 버튼을 누릅니다.',
          '버튼이 안 뜨면 Chrome 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택합니다.',
        ]
      : [
          'Chrome 또는 Edge에서 이 설치 페이지를 엽니다.',
          '주소창 오른쪽 설치 아이콘을 누릅니다.',
          '설치를 승인하면 바탕화면과 시작 메뉴에서 실행할 수 있습니다.',
        ];

  return (
    <main className="h-full overflow-y-auto bg-background px-5 py-8 text-foreground">
      <div className="mx-auto max-w-md pb-8">
        <section className="rounded-3xl border border-card-border bg-card p-6 text-center shadow-xl">
          <img
            src="/icons/icon-192.png"
            alt="지식정보 119 아이콘"
            className="mx-auto h-24 w-24 rounded-3xl shadow-lg"
          />
          <p className="mt-4 text-xs font-extrabold text-primary">개인 설치용 웹앱 · v{APP_VERSION}</p>
          <h1 className="mt-1 text-3xl font-black">{APP_NAME}</h1>
          <p className="mt-3 text-sm font-bold leading-6 text-muted-foreground">
            주식·코인 정보, 분석, 알림과 승인형 자동매매를 한 앱에서 확인합니다.
          </p>

          <div className="mt-5 flex items-center justify-center gap-2 rounded-2xl bg-secondary px-4 py-3 text-sm font-extrabold">
            {installed ? <CheckCircle2 className="h-5 w-5 text-positive" /> : <MonitorSmartphone className="h-5 w-5 text-primary" />}
            <span>{message}</span>
          </div>

          <button
            type="button"
            onClick={() => void install()}
            disabled={installed}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-4 font-black text-primary-foreground transition active:scale-[0.98] disabled:cursor-default disabled:opacity-60"
          >
            {installed ? <CheckCircle2 className="h-5 w-5" /> : <Download className="h-5 w-5" />}
            {installed ? '설치 완료' : '지식정보 설치'}
          </button>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => void copyLink()}
              className="flex items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold active:scale-[0.98]"
            >
              {copied ? <CheckCircle2 className="h-4 w-4 text-positive" /> : <Copy className="h-4 w-4" />}
              {copied ? '복사 완료' : '링크 복사'}
            </button>
            <button
              type="button"
              onClick={() => void shareLink()}
              className="flex items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold active:scale-[0.98]"
            >
              <Share2 className="h-4 w-4" />링크 공유
            </button>
          </div>
        </section>

        <section className="mt-5 rounded-3xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            {platform === 'desktop' ? <MonitorSmartphone className="h-6 w-6 text-primary" /> : <Smartphone className="h-6 w-6 text-primary" />}
            <div>
              <h2 className="font-black">현재 기기 설치 방법</h2>
              <p className="mt-1 text-xs font-bold text-muted-foreground">
                {platform === 'ios' ? 'iPhone·iPad Safari' : platform === 'android' ? 'Android Chrome' : 'Windows·Mac Chrome/Edge'}
              </p>
            </div>
          </div>
          <ol className="mt-4 space-y-3">
            {guide.map((step, index) => (
              <li key={step} className="flex gap-3 text-sm font-bold leading-6 text-muted-foreground">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-black text-primary-foreground">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-5 rounded-3xl border border-card-border bg-card p-5 text-sm font-bold leading-6 text-muted-foreground">
          <h2 className="text-base font-black text-foreground">설치 전 확인</h2>
          <p className="mt-3">이 앱은 Play Store나 App Store에 등록하지 않고 설치 링크로 공유하는 PWA입니다.</p>
          <p className="mt-2">설치 후 처음 실행하면 로그인 또는 회원가입 화면이 열리며, 관리자가 승인한 계정만 기능을 사용할 수 있습니다.</p>
          <p className="mt-2">실제 주문은 자동으로 실행되지 않으며 주문계획을 확인하고 건별 승인해야 합니다.</p>
        </section>

        <a
          href="/"
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border bg-card px-5 py-4 font-black text-primary active:scale-[0.98]"
        >
          <ExternalLink className="h-5 w-5" />지식정보 열기
        </a>
      </div>
    </main>
  );
}
