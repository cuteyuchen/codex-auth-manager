import { ActivationBroker } from "./activation-broker.js";
import { createHeroSmsProvider } from "./heroSMS.js";

type HeroSMSBrokerOption = {
  apiKey: string;
  country: number;
  maxPrice: number;
  pollAttempts: number;
  pollIntervalMs: number;
}

export const createSMSBroker = (option: HeroSMSBrokerOption) => {
  return new ActivationBroker(
    createHeroSmsProvider({
      apiKey: option.apiKey,
      defaultRequestOptions: {
        // openai
        service: "dr",
        country: option.country,
        maxPrice: option.maxPrice,
        fixedPrice: true,
      },
      defaultWaitForCodeOptions: {
        markReady: false,
        completeOnCode: false,
        pollAttempts: option.pollAttempts,
        pollIntervalMs: option.pollIntervalMs,
      },
    }),
  );
};
