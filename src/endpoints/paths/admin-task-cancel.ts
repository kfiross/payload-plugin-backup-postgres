import type { Endpoint } from 'payload'

import type { BackupPluginOptions } from '../../types'

import { cancelBackupTask, getBackupTask, pollSecretsMatch } from '../../core/taskProgress'
import { getAuthorizedBackupAdmin, jsonError } from '../shared'

export function createAdminTaskCancelEndpoint(options: BackupPluginOptions): Endpoint {
  return {
    handler: async (req) => {
      const { payload } = req
      const id = req.routeParams?.id
      if (typeof id !== 'string' || !id) {
        return jsonError('Not found', 404)
      }

      const task = await getBackupTask(payload, id)
      if (!task || task.kind !== 'backup') {
        return jsonError('Not found', 404)
      }

      const pollSecret =
        req.headers.get('x-backup-poll-secret') ??
        req.headers.get('authorization')?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ??
        ''
      const pollOk = pollSecretsMatch(pollSecret, task.pollSecret)
      if (!pollOk) {
        const user = await getAuthorizedBackupAdmin(req, options)
        if (!user) {
          return jsonError('Unauthorized', 401)
        }
      }

      const updated = await cancelBackupTask(payload, id)
      if (!updated) {
        return jsonError('Task not found', 404)
      }
      return Response.json(updated)
    },
    method: 'post',
    path: '/backup-postgres/admin/task/:id/cancel',
  }
}
