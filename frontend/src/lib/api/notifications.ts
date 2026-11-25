import type { NotificationRow, NotificationType } from "@/types/api";
import { http } from "./http";

export type { NotificationRow, NotificationType };

export const listNotifications = ({
  data,
}: { data?: { filter?: "all" | "unread"; page?: number; pageSize?: number } } = {}) =>
  http.get<{
    notifications: NotificationRow[];
    totalCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>("/notifications", data ?? {});

export const getUnreadCount = () => http.get<{ count: number }>("/notifications/unread-count");

export const markNotificationsRead = ({ data }: { data: { ids: string[] } }) =>
  http.post<{ success: boolean; count: number }>("/notifications/mark-read", data);

export const markAllNotificationsRead = () =>
  http.post<{ success: boolean; count: number }>("/notifications/mark-all-read");

export const deleteNotification = ({ data }: { data: { id: string } }) =>
  http.delete<{ success: boolean }>(`/notifications/${data.id}`);
