// Platform branding and company contact channels storage.
import type { Kysely } from 'kysely';
import type { DB } from './schema.js';

export interface PlatformBrandingRecord {
  readonly name: string;
  readonly logo: string | null;
  readonly email: string;
  readonly phone: string;
  readonly whatsapp: string;
  readonly address: string;
  readonly hours: string;
  readonly updatedAt?: Date | undefined;
}

export interface UpdateBrandingInput {
  readonly name?: string | undefined;
  readonly logo?: string | null | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly whatsapp?: string | undefined;
  readonly address?: string | undefined;
  readonly hours?: string | undefined;
}

const DEFAULT_RECORD: PlatformBrandingRecord = {
  name: 'Aza WealthKare',
  logo: null,
  email: 'support@azawealthkare.com',
  phone: '+91 98765 43210',
  whatsapp: '+91 98765 43210',
  address: 'Unit No-217 second Floor Tower 3 RPS 12TH Avenue Sector  27C, Main Mathura Road  Faridabad 121003',
  hours: 'Monday – Saturday: 9:00 AM – 8:00 PM IST',
};

/** Get the current platform branding and contact channels. */
export async function getPlatformBranding(db: Kysely<DB>): Promise<PlatformBrandingRecord> {
  const row = await db.selectFrom('platform_branding')
    .select(['name', 'logo', 'email', 'phone', 'whatsapp', 'address', 'hours', 'updated_at as updatedAt'])
    .where('id', '=', 'default')
    .executeTakeFirst();

  if (!row) {
    return DEFAULT_RECORD;
  }

  return {
    name: row.name,
    logo: row.logo,
    email: row.email,
    phone: row.phone,
    whatsapp: row.whatsapp,
    address: row.address,
    hours: row.hours,
    updatedAt: row.updatedAt ? (row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt as unknown as string | number)) : undefined,
  };
}

/** Update the platform branding and contact channels. */
export async function updatePlatformBranding(
  db: Kysely<DB>,
  input: UpdateBrandingInput,
  updatedBy?: string | null,
): Promise<PlatformBrandingRecord> {
  const updates: Record<string, unknown> = {
    updated_at: new Date(),
    updated_by: updatedBy ?? null,
  };

  if (input.name !== undefined && input.name.trim() !== '') updates['name'] = input.name.trim();
  if (input.logo !== undefined) updates['logo'] = input.logo && input.logo.trim() !== '' ? input.logo.trim() : null;
  if (input.email !== undefined && input.email.trim() !== '') updates['email'] = input.email.trim();
  if (input.phone !== undefined && input.phone.trim() !== '') updates['phone'] = input.phone.trim();
  if (input.whatsapp !== undefined && input.whatsapp.trim() !== '') updates['whatsapp'] = input.whatsapp.trim();
  if (input.address !== undefined && input.address.trim() !== '') updates['address'] = input.address.trim();
  if (input.hours !== undefined && input.hours.trim() !== '') updates['hours'] = input.hours.trim();

  // Upsert the 'default' row
  await db.insertInto('platform_branding')
    .values({
      id: 'default',
      name: input.name?.trim() || DEFAULT_RECORD.name,
      logo: input.logo?.trim() || null,
      email: input.email?.trim() || DEFAULT_RECORD.email,
      phone: input.phone?.trim() || DEFAULT_RECORD.phone,
      whatsapp: input.whatsapp?.trim() || DEFAULT_RECORD.whatsapp,
      address: input.address?.trim() || DEFAULT_RECORD.address,
      hours: input.hours?.trim() || DEFAULT_RECORD.hours,
      updated_at: new Date(),
      updated_by: updatedBy ?? null,
    } as never)
    .onConflict((oc) => oc.column('id').doUpdateSet(updates as never))
    .execute();

  return getPlatformBranding(db);
}
