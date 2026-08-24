import { GatewayError } from "./gateway.mjs";

export const DISABLED_BROKER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    providerId: "toss-disabled",
    providerName: "Toss Securities",
    canonicalStockAuthority: true,
    status: "CONTRACT_PLACEHOLDER_ONLY",
  }),
  Object.freeze({
    providerId: "kis-disabled",
    providerName: "Korea Investment & Securities",
    canonicalStockAuthority: false,
    status: "NON_CANONICAL_CANDIDATE_DISABLED",
  }),
  Object.freeze({
    providerId: "kiwoom-disabled",
    providerName: "Kiwoom Securities",
    canonicalStockAuthority: false,
    status: "NON_CANONICAL_CANDIDATE_DISABLED",
  }),
]);

class DisabledBrokerAdapter {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }

  getCapabilities() {
    return {
      providerId: this.descriptor.providerId,
      providerName: this.descriptor.providerName,
      integrationStatus: this.descriptor.status,
      canonicalStockAuthority: this.descriptor.canonicalStockAuthority,
      executionMode: "DISABLED",
      liveTrading: false,
      privateTradingApiAllowed: false,
      outboundNetwork: false,
      brokerCredentialsAccepted: false,
      accountReadAllowed: false,
      orderSubmissionAllowed: false,
      cancelAllowed: false,
      amendAllowed: false,
      transferAllowed: false,
      withdrawalAllowed: false,
    };
  }

  #blocked() {
    throw new GatewayError(
      "BROKER_ADAPTER_DISABLED",
      `${this.descriptor.providerName} adapter is a disabled contract placeholder only`,
      503,
    );
  }

  async previewOrder() {
    return this.#blocked();
  }

  async submitOrder() {
    return this.#blocked();
  }

  async cancelOrder() {
    return this.#blocked();
  }

  async getOrder() {
    return this.#blocked();
  }
}

export class TossDisabledBrokerAdapter extends DisabledBrokerAdapter {
  constructor() {
    super(DISABLED_BROKER_DESCRIPTORS[0]);
  }
}

export class KisDisabledBrokerAdapter extends DisabledBrokerAdapter {
  constructor() {
    super(DISABLED_BROKER_DESCRIPTORS[1]);
  }
}

export class KiwoomDisabledBrokerAdapter extends DisabledBrokerAdapter {
  constructor() {
    super(DISABLED_BROKER_DESCRIPTORS[2]);
  }
}
