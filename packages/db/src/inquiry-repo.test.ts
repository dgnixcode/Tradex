import { describe, expect, it } from 'vitest';
import { createInquiry, InquiryRepoError } from './inquiry-repo.js';

describe('InquiryRepo input validation', () => {
  it('throws InquiryRepoError when required fields are blank', async () => {
    await expect(createInquiry({} as never, {
      name: '  ',
      email: 'test@example.com',
      phone: '1234567890',
      capital: '10L',
      exchange: 'CoinDCX',
      method: 'WhatsApp',
    })).rejects.toThrow(InquiryRepoError);

    await expect(createInquiry({} as never, {
      name: 'Rahul Sharma',
      email: '  ',
      phone: '1234567890',
      capital: '10L',
      exchange: 'CoinDCX',
      method: 'WhatsApp',
    })).rejects.toThrow(InquiryRepoError);

    await expect(createInquiry({} as never, {
      name: 'Rahul Sharma',
      email: 'test@example.com',
      phone: '',
      capital: '10L',
      exchange: 'CoinDCX',
      method: 'WhatsApp',
    })).rejects.toThrow(InquiryRepoError);
  });
});
