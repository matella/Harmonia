import { inject } from '@angular/core';
import { Router, type CanMatchFn, type Routes } from '@angular/router';

import { AppStore } from './core/state/app-store';

const requireProfile: CanMatchFn = () => inject(AppStore).hasProfile() || inject(Router).parseUrl('/welcome');
const requireNoProfile: CanMatchFn = () => !inject(AppStore).hasProfile() || inject(Router).parseUrl('/tabs/home');

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'tabs/home' },
  {
    path: 'welcome',
    canMatch: [requireNoProfile],
    loadComponent: () => import('./features/onboarding/onboarding.page').then((m) => m.OnboardingPage),
  },
  {
    path: 'tabs',
    canMatch: [requireProfile],
    loadComponent: () => import('./features/tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      { path: 'home', loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage) },
      { path: 'timeline', loadComponent: () => import('./features/timeline/timeline.page').then((m) => m.TimelinePage) },
      { path: 'dates', loadComponent: () => import('./features/dates/dates.page').then((m) => m.DatesPage) },
      { path: 'memories', loadComponent: () => import('./features/memories/memories.page').then((m) => m.MemoriesPage) },
      { path: '', pathMatch: 'full', redirectTo: 'home' },
    ],
  },
  {
    path: '',
    canMatch: [requireProfile],
    children: [
      { path: 'counter', loadComponent: () => import('./features/home/counter-detail.page').then((m) => m.CounterDetailPage) },
      {
        path: 'milestone/new',
        loadComponent: () => import('./features/dates/milestone-editor.page').then((m) => m.MilestoneEditorPage),
      },
      {
        path: 'milestone/:id/edit',
        loadComponent: () => import('./features/dates/milestone-editor.page').then((m) => m.MilestoneEditorPage),
      },
      {
        path: 'milestone/:id',
        loadComponent: () => import('./features/dates/milestone-detail.page').then((m) => m.MilestoneDetailPage),
      },
      {
        path: 'memory/new',
        loadComponent: () => import('./features/memories/memory-editor.page').then((m) => m.MemoryEditorPage),
      },
      {
        path: 'memory/:id/edit',
        loadComponent: () => import('./features/memories/memory-editor.page').then((m) => m.MemoryEditorPage),
      },
      {
        path: 'memory/:id',
        loadComponent: () => import('./features/memories/memory-detail.page').then((m) => m.MemoryDetailPage),
      },
      { path: 'recap', loadComponent: () => import('./features/recap/recap.page').then((m) => m.RecapPage) },
      { path: 'settings', loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage) },
      {
        path: 'settings/profile',
        loadComponent: () => import('./features/settings/profile-editor.page').then((m) => m.ProfileEditorPage),
      },
      {
        path: 'settings/appearance',
        loadComponent: () => import('./features/settings/appearance.page').then((m) => m.AppearancePage),
      },
      {
        path: 'settings/reminders',
        loadComponent: () => import('./features/settings/reminder-settings.page').then((m) => m.ReminderSettingsPage),
      },
      {
        path: 'settings/widgets',
        loadComponent: () => import('./features/settings/widget-settings.page').then((m) => m.WidgetSettingsPage),
      },
      {
        path: 'settings/privacy',
        loadComponent: () => import('./features/settings/privacy-data.page').then((m) => m.PrivacyDataPage),
      },
      {
        path: 'settings/sharing',
        loadComponent: () => import('./features/settings/sharing.page').then((m) => m.SharingPage),
      },
      { path: 'settings/trash', loadComponent: () => import('./features/settings/trash.page').then((m) => m.TrashPage) },
      { path: 'settings/about', loadComponent: () => import('./features/settings/about.page').then((m) => m.AboutPage) },
    ],
  },
  { path: '**', redirectTo: 'tabs/home' },
];
