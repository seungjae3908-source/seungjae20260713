import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getScannerStrategyProfile, listScannerStrategyProfiles } from './scanner-strategy-profile.service';

describe('scanner strategy profiles', () => {
  it('defines four markets times three horizons without execution authority', () => {
    const profiles = listScannerStrategyProfiles();
    assert.equal(profiles.length, 12);
    for (const profile of profiles) {
      assert.equal(profile.executionAuthority, 'NONE');
      assert.ok(profile.version);
      assert.ok(profile.primaryTimeframe);
      assert.ok(profile.indicators.length > 0);
      assert.equal(Object.isFrozen(profile), true);
    }
  });

  it('keeps same UX horizon but market-specific internal profile', () => {
    const kr = getScannerStrategyProfile('KR_STOCK', 'SCALP');
    const futures = getScannerStrategyProfile('CRYPTO_FUTURES', 'SCALP');
    assert.notEqual(kr.id, futures.id);
    assert.notDeepEqual(kr.scannerConditions, futures.scannerConditions);
  });

  it('defines an independent position profile', () => {
    const position = getScannerStrategyProfile('US_STOCK', 'POSITION');
    const swing = getScannerStrategyProfile('US_STOCK', 'SWING');
    assert.notEqual(position.id, swing.id);
    assert.notDeepEqual(position.indicatorWeights, swing.indicatorWeights);
  });
});
