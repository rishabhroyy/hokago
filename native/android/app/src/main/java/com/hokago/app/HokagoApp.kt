package com.hokago.app

import android.app.Application

class HokagoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: HokagoApp
    }
}