import { createContext, useContext, type ReactNode } from 'react';
import type { SnapshotRepositories } from '../repositories/core.js';

const Context = createContext<SnapshotRepositories | null>(null);
export function RepositoryProvider({ repositories, children }: { repositories: SnapshotRepositories; children: ReactNode }) {
  return <Context.Provider value={repositories}>{children}</Context.Provider>;
}
export function useRepositories(): SnapshotRepositories {
  const value = useContext(Context);
  if (!value) throw new Error('RepositoryProvider is required');
  return value;
}
