import { configureStore } from '@reduxjs/toolkit';
import { raceApi } from './api';
import { createRegattaSlice, loadState, STORAGE_KEY_V2 } from './ledgerSlice';

const slice = createRegattaSlice(loadState(typeof localStorage === 'undefined' ? undefined : localStorage));

export const {
  startRace,
  freezeRace,
  appendAdjudication,
  createCorrectionVersion,
  publishVersion,
  registerProtest,
  setProtestReviewing,
  resolveProtest,
  resetAll
} = slice.actions;

export type FreezeResultInput = import('./ledgerSlice').FreezeResultInput;
export type { AppendAdjudicationInput, AdjudicationKind, JudgeRole } from './types';

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => {
  try {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(store.getState().regatta));
  } catch {
    /* 存储不可用时忽略 */
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
