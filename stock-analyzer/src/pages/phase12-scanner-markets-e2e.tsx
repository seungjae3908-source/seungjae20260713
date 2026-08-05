import { useEffect } from 'react';
import { useAssetMode } from '@/lib/asset-mode';
import CryptoFuturesScannerPage from '@/pages/crypto-futures-scanner';
import CryptoSpotScannerPage from '@/pages/crypto-spot-scanner';

export default function Phase12ScannerMarketsE2EPage() {
  const mode = useAssetMode();
  useEffect(() => {
    mode.setAsset('coin');
    mode.setCoinMarket('spot');
    // Fixture entry state is intentionally spot; the user-facing switches can
    // then move to futures without remounting the application providers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return mode.coinMarket === 'futures'
    ? <CryptoFuturesScannerPage />
    : <CryptoSpotScannerPage />;
}
