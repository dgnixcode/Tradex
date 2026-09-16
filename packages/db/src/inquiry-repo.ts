// Consultation inquiries storage — inbound client lead generation.
import type { Kysely } from 'kysely';
import type { DB, InquiryStatus } from './schema.js';

export class InquiryRepoError extends Error {
  override readonly name = 'InquiryRepoError';
}

export interface InquiryRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly capital: string;
  readonly exchange: string;
  readonly method: string;
  readonly notes: string | null;
  readonly status: InquiryStatus;
  readonly createdAt: Date;
  readonly contactedAt: Date | null;
  readonly contactedBy: string | null;
}

export interface CreateInquiryInput {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly capital: string;
  readonly exchange: string;
  readonly method: string;
  readonly notes?: string | null | undefined;
}

/** Insert an inbound consultation request. */
export async function createInquiry(
  db: Kysely<DB>,
  input: CreateInquiryInput,
): Promise<{ id: string }> {
  if (!input.name.trim() || !input.email.trim() || !input.phone.trim()) {
    throw new InquiryRepoError('name, email and phone are required');
  }

  const row = await db.insertInto('consultation_inquiry')
    .values({
      name: input.name.trim(),
      email: input.email.toLowerCase().trim(),
      phone: input.phone.trim(),
      capital: input.capital.trim(),
      exchange: input.exchange.trim(),
      method: input.method.trim(),
      notes: input.notes?.trim() || null,
      status: 'new' as InquiryStatus,
    } as never)
    .returning('id')
    .executeTakeFirst();

  if (row === undefined) throw new InquiryRepoError('failed to insert consultation inquiry');
  return { id: (row as { id: string }).id };
}

/** List all consultation inquiries, newest first. */
export async function listInquiries(
  db: Kysely<DB>,
  opts: { status?: InquiryStatus | undefined } = {},
): Promise<InquiryRecord[]> {
  let query = db.selectFrom('consultation_inquiry')
    .select([
      'id',
      'name',
      'email',
      'phone',
      'capital',
      'exchange',
      'method',
      'notes',
      'status',
      'created_at as createdAt',
      'contacted_at as contactedAt',
      'contacted_by as contactedBy',
    ])
    .orderBy('created_at', 'desc');

  if (opts.status !== undefined) {
    query = query.where('status', '=', opts.status);
  }

  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    capital: r.capital,
    exchange: r.exchange,
    method: r.method,
    notes: r.notes,
    status: r.status as InquiryStatus,
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string | number),
    contactedAt: r.contactedAt ? (r.contactedAt instanceof Date ? r.contactedAt : new Date(r.contactedAt as unknown as string | number)) : null,
    contactedBy: r.contactedBy,
  }));
}

/** Update the status and contacted details of an inquiry. */
export async function updateInquiryStatus(
  db: Kysely<DB>,
  id: string,
  status: InquiryStatus,
  opts: { contactedBy?: string | undefined; now?: Date | undefined } = {},
): Promise<boolean> {
  const contactedAt = status === 'new' ? null : (opts.now ?? new Date());
  const contactedBy = status === 'new' ? null : (opts.contactedBy ?? null);

  const result = await db.updateTable('consultation_inquiry')
    .set({
      status,
      contacted_at: contactedAt,
      ...(contactedBy !== null ? { contacted_by: contactedBy } : {}),
    } as never)
    .where('id', '=', id)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) > 0;
}
