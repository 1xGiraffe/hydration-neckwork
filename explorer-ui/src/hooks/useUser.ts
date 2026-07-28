import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { api, userApi } from '../api/explorer'
import { useSession, setSession } from '../session'
import { setTagMap } from '../userTags'

export function useMe() {
  const session = useSession()
  return useQuery({ queryKey: ['user', 'me', session?.accountId], queryFn: ({ signal }) => userApi.me(signal), enabled: !!session, staleTime: 30_000 })
}

// Fetch + push the viewer's tag map into the resolution store. Mounted once
// (Topbar), so every pill on every page resolves through it.
export function useTagMapSync() {
  const session = useSession()
  const q = useQuery({ queryKey: ['user', 'tag-map', session?.accountId], queryFn: ({ signal }) => userApi.tagMap(signal), enabled: !!session, staleTime: 30_000 })
  useEffect(() => { setTagMap(session ? q.data ?? null : null) }, [session, q.data])
  return q
}

export function useLibraries() {
  return useQuery({ queryKey: ['libraries'], queryFn: ({ signal }) => api.libraries(signal), staleTime: 30_000, placeholderData: keepPreviousData })
}
export function useLibrary(id: string | null, authed: boolean) {
  return useQuery({
    queryKey: ['library', id, authed],
    queryFn: ({ signal }) => (authed ? userApi.library(id!, signal) : api.library(id!, signal)),
    enabled: !!id, staleTime: 15_000,
  })
}
export function useAddressLibraries(address: string | null) {
  return useQuery({ queryKey: ['address-libraries', address], queryFn: ({ signal }) => api.addressLibraries(address!, signal), enabled: !!address, staleTime: 30_000 })
}

// One mutation wrapper: every user mutation invalidates the user scope (me,
// tag-map, library details) so the next render resolves with fresh data.
export function useUserMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user'] })
      void qc.invalidateQueries({ queryKey: ['libraries'] })
      void qc.invalidateQueries({ queryKey: ['library'] })
      // Profile edits change how the account page itself renders (header name,
      // avatar), and that page reads the ADDRESS query — refresh it too. Cheap:
      // only mounted address queries refetch, and user mutations are rare.
      void qc.invalidateQueries({ queryKey: ['address'] })
    },
  })
}

export async function logout(): Promise<void> {
  try { await userApi.logout() } finally { setSession(null) }
}
