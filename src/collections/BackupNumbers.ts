import type { CollectionConfig } from 'payload'

/** Persistent, non-reusable numbers assigned to backup archive pathnames. */
export const BackupNumbersCollection: CollectionConfig = {
  slug: 'backup-numbers',
  access: {
    create: () => false,
    delete: () => false,
    read: () => false,
    update: () => false,
  },
  admin: {
    hidden: true,
  },
  fields: [
    {
      name: 'number',
      type: 'number',
      required: true,
      unique: true,
    },
    {
      name: 'pathname',
      type: 'text',
      required: true,
      unique: true,
    },
  ],
  timestamps: false,
}
