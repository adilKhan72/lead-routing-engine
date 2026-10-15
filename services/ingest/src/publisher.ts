import { publishLeadReceived, type Redis } from '@lre/shared';

export interface LeadPublisher {
  publishReceived(leadId: string): Promise<void>;
}

export class RedisStreamPublisher implements LeadPublisher {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async publishReceived(leadId: string): Promise<void> {
    await publishLeadReceived(this.redis, leadId);
  }
}
