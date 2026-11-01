"""Stand-in for the game's chat: a window titled "Path of Exile". Enter opens the chat line,
Ctrl+A selects all, Ctrl+V pastes, Enter sends (appends the line to argv[1]) and closes chat."""
import sys
import tkinter as tk

out = sys.argv[1]
root = tk.Tk()
root.title("Path of Exile")
root.geometry("1280x720+60+60")
root.configure(bg="#202020")
chat = tk.Entry(root, width=80, font=("Consolas", 14))
state = {"open": False}


def on_enter(e=None):
    if not state["open"]:
        state["open"] = True
        chat.delete(0, "end")
        chat.place(x=20, y=660)
        chat.focus_set()
    else:
        with open(out, "a", encoding="utf-8") as f:
            f.write(chat.get() + "\n")
        chat.delete(0, "end")
        chat.place_forget()
        state["open"] = False
        root.focus_set()
    return "break"


def select_all(e):
    chat.select_range(0, "end")
    chat.icursor("end")
    return "break"


root.bind("<Return>", on_enter)
chat.bind("<Return>", on_enter)
chat.bind("<Control-a>", select_all)
chat.bind("<Control-A>", select_all)
root.after(60000, root.destroy)  # never outlive the test
root.mainloop()
